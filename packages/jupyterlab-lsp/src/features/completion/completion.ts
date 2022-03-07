import { JupyterFrontEnd } from '@jupyterlab/application';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { IDocumentWidget } from '@jupyterlab/docregistry';
import { NotebookPanel } from '@jupyterlab/notebook';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ILSPCompletionThemeManager } from '@krassowski/completion-theme/lib/types';
import type * as CodeMirror from 'codemirror';

import { CodeCompletion as LSPCompletionSettings } from '../../_completion';
import { WidgetAdapter } from '../../adapters/adapter';
import { IDocumentConnectionData } from '../../connection_manager';
import { CodeMirrorIntegration } from '../../editor_integration/codemirror';
import { FeatureSettings, IFeatureLabIntegration } from '../../feature';
import { ILSPAdapterManager, ILSPLogConsole } from '../../tokens';

import { LSPConnector } from './completion_handler';
import { LazyCompletionItem } from './item';
import { ICompletionData, LSPCompletionRenderer } from './renderer';

export class CompletionCM extends CodeMirrorIntegration {
  private _completionCharacters: string[];

  get settings() {
    return super.settings as FeatureSettings<LSPCompletionSettings>;
  }

  get completionCharacters() {
    if (
      this._completionCharacters == null ||
      !this._completionCharacters.length
    ) {
      this._completionCharacters =
        this.connection.getLanguageCompletionCharacters();
    }
    return this._completionCharacters;
  }

  // public handleCompletion(completions: lsProtocol.CompletionItem[]) {
  // TODO: populate the (already displayed) completions list if the completions timed out initially?
  // }

  afterChange(change: CodeMirror.EditorChange): void {
    // TODO: maybe the completer could be kicked off in the handleChange() method directly; signature help still
    //  requires an up-to-date virtual document on the LSP side, so we need to wait for sync.

    // note: trigger character completion need to be have a higher priority than auto-invoked completion
    // because the latter does not work for on-dot completion due to suppression of trivial suggestions
    // see gh430
    let last_character = this.extract_last_character(change);
    if (this.completionCharacters.indexOf(last_character) > -1) {
      this.virtual_editor.console.log(
        'Will invoke completer after',
        last_character
      );
      return;
    }
  }
}

export class CompletionLabIntegration implements IFeatureLabIntegration {
  // TODO: maybe instead of creating it each time, keep a hash map instead?
  protected current_completion_connector: LSPConnector;
  protected current_adapter: WidgetAdapter<IDocumentWidget> | null = null;
  protected renderer: LSPCompletionRenderer;
  private _latestActiveItem: LazyCompletionItem | null = null;

  constructor(
    private app: JupyterFrontEnd,
    public settings: FeatureSettings<LSPCompletionSettings>,
    private adapterManager: ILSPAdapterManager,
    private completionThemeManager: ILSPCompletionThemeManager,
    private console: ILSPLogConsole,
    private renderMimeRegistry: IRenderMimeRegistry
  ) {
    console.log(this.app, this.adapterManager);
    const markdown_renderer =
      this.renderMimeRegistry.createRenderer('text/markdown');
    this.renderer = new LSPCompletionRenderer({
      integrator: this,
      markdownRenderer: markdown_renderer,
      latexTypesetter: this.renderMimeRegistry.latexTypesetter,
      console: console.scope('renderer')
    });
    this.renderer.activeChanged.connect(this.active_completion_changed, this);
    this.renderer.itemShown.connect(this.resolve_and_update, this);
    // TODO: figure out a better way to disable lab integration elements (postpone initialization?)
    settings.ready
      .then(() => {
        if (!settings.composite.disable) {
          adapterManager.adapterChanged.connect(this.swap_adapter, this);
        }
      })
      .catch(console.warn);
    settings.changed.connect(() => {
      completionThemeManager.set_theme(this.settings.composite.theme);
      completionThemeManager.set_icons_overrides(
        this.settings.composite.typesMap
      );
      if (!settings.composite.disable) {
        document.body.dataset.lspCompleterLayout =
          this.settings.composite.layout;
      }
    });
  }

  protected fetchDocumentation(item: LazyCompletionItem): void {
    if (!item) {
      return;
    }
    item
      .lspResolve()
      .then(resolvedCompletionItem => {
        if (item.self !== this._latestActiveItem!.self) {
          return;
        }
        if (resolvedCompletionItem === null) {
          return;
        }
      })
      .catch(e => {
        // disabling placeholder can remove currently displayed documentation,
        // so only do that if this is really the active item!
        this.console.warn(e);
      });
  }

  active_completion_changed(
    renderer: LSPCompletionRenderer,
    active_completion: ICompletionData
  ) {
    let { item } = active_completion;
    this._latestActiveItem = item;
    if (!item.supportsResolution()) {
      return;
    }

    if (item.needsResolution()) {
      this.fetchDocumentation(item);
    } else if (item.isResolved()) {
      /** */
    } else {
      // resolution has already started, but the re-render update could have been invalidated
      // by user action, so let's ensure the documentation will get shown this time.
      this.fetchDocumentation(item);
    }
  }

  private resolve_and_update(
    renderer: LSPCompletionRenderer,
    active_completion: ICompletionData
  ) {
    let { item, element } = active_completion;
    if (!item.supportsResolution()) {
      this.renderer.updateExtraInfo(item, element);
      return;
    }

    if (item.isResolved()) {
      this.renderer.updateExtraInfo(item, element);
    } else {
      // supportsResolution as otherwise would short-circuit above
      item
        .lspResolve()
        .then(resolvedCompletionItem => {
          this.renderer.updateExtraInfo(item, element);
        })
        .catch(e => {
          this.console.warn(e);
        });
    }
  }

  private swap_adapter(
    manager: ILSPAdapterManager,
    adapter: WidgetAdapter<IDocumentWidget>
  ) {
    if (this.current_adapter) {
      // disconnect signals from the old adapter
      this.current_adapter.adapterConnected.disconnect(
        this.connect_completion,
        this
      );
    }
    this.current_adapter = adapter;
    // connect the new adapter
    if (this.current_adapter.isConnected) {
      this.connect_completion(this.current_adapter);
      // TODO: what to do if adapter.activeEditor was just deleted/there is none because focus shifted?
    }
    // connect signals to the new adapter
    this.current_adapter.adapterConnected.connect(
      this.connect_completion,
      this
    );
  }

  connect_completion(
    adapter: WidgetAdapter<IDocumentWidget>,
    data?: IDocumentConnectionData
  ) {
    let editor = adapter.activeEditor;
    if (editor == null) {
      return;
    }
    this.set_completion_connector(adapter, editor);
  }

  private set_completion_connector(
    adapter: WidgetAdapter<IDocumentWidget>,
    editor: CodeEditor.IEditor
  ) {
    this.current_completion_connector = new LSPConnector({
      editor: editor,
      themeManager: this.completionThemeManager,
      connections: this.current_adapter!.connection_manager.connections,
      virtual_editor: this.current_adapter!.virtual_editor,
      settings: this.settings,
      labIntegration: this,
      // it might or might not be a notebook panel (if it is not, the sessionContext and session will just be undefined)
      session: (this.current_adapter!.widget as NotebookPanel)?.sessionContext
        ?.session,
      console: this.console
    });
  }
}
