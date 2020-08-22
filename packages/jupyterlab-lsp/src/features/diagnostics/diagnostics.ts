import * as CodeMirror from 'codemirror';
import * as lsProtocol from 'vscode-languageserver-protocol';
import { PositionConverter } from '../../converter';
import { IEditorPosition, IVirtualPosition } from '../../positioning';
import { DiagnosticSeverity } from '../../lsp';
import { DefaultMap, uris_equal } from '../../utils';
import { MainAreaWidget } from '@jupyterlab/apputils';
import {
  DiagnosticsDatabase,
  DiagnosticsListing,
  IEditorDiagnostic
} from './listing';
import { VirtualDocument } from '../../virtual/document';
import { FeatureSettings } from '../../feature';
import { CodeMirrorIntegration } from '../../editor_integration/codemirror';
import { CodeDiagnostics as LSPDiagnosticsSettings } from '../../_diagnostics';
import { CodeMirrorVirtualEditor } from '../../virtual/codemirror_editor';
import { LabIcon } from '@jupyterlab/ui-components';
import diagnosticsSvg from '../../../style/icons/diagnostics.svg';

export const diagnosticsIcon = new LabIcon({
  name: 'lsp:diagnostics',
  svgstr: diagnosticsSvg
});

class DiagnosticsPanel {
  private _content: DiagnosticsListing = null;
  private _widget: MainAreaWidget<DiagnosticsListing> = null;
  is_registered = false;

  get widget() {
    if (this._widget == null || this._widget.content.model == null) {
      if (this._widget && !this._widget.isDisposed) {
        this._widget.dispose();
      }
      this._widget = this.init_widget();
    }
    return this._widget;
  }

  get content() {
    return this.widget.content;
  }

  protected init_widget() {
    this._content = new DiagnosticsListing(new DiagnosticsListing.Model());
    this._content.model.diagnostics = new DiagnosticsDatabase();
    this._content.addClass('lsp-diagnostics-panel-content');
    const widget = new MainAreaWidget({ content: this._content });
    widget.id = 'lsp-diagnostics-panel';
    widget.title.label = 'Diagnostics Panel';
    widget.title.closable = true;
    widget.title.icon = diagnosticsIcon;
    return widget;
  }

  update() {
    // if not attached, do not bother to update
    if (!this.widget.isAttached) {
      return;
    }
    this.widget.content.update();
  }
}

export const diagnostics_panel = new DiagnosticsPanel();
export const diagnostics_databases = new WeakMap<
  CodeMirrorVirtualEditor,
  DiagnosticsDatabase
>();

export class DiagnosticsCM extends CodeMirrorIntegration {
  settings: FeatureSettings<LSPDiagnosticsSettings>;

  register(): void {
    this.connection_handlers.set('diagnostic', this.handleDiagnostic);
    this.wrapper_handlers.set('focusin', this.switchDiagnosticsPanelSource);
    this.unique_editor_ids = new DefaultMap(() => this.unique_editor_ids.size);
    if (!diagnostics_databases.has(this.virtual_editor)) {
      diagnostics_databases.set(this.virtual_editor, new DiagnosticsDatabase());
    }
    this.diagnostics_db = diagnostics_databases.get(this.virtual_editor);
    super.register();
  }

  private unique_editor_ids: DefaultMap<CodeMirror.Editor, number>;
  private marked_diagnostics: Map<string, CodeMirror.TextMarker> = new Map();
  /**
   * Allows access to the most recent diagnostics in context of the editor.
   *
   * One can use VirtualEditorForNotebook.find_cell_by_editor() to find
   * the corresponding cell in notebook.
   * Can be used to implement a Panel showing diagnostics list.
   *
   * Maps virtual_document.uri to IEditorDiagnostic[].
   */
  public diagnostics_db: DiagnosticsDatabase;

  switchDiagnosticsPanelSource = () => {
    if (
      diagnostics_panel.content.model.virtual_editor === this.virtual_editor
    ) {
      return;
    }
    diagnostics_panel.content.model.diagnostics = this.diagnostics_db;
    diagnostics_panel.content.model.virtual_editor = this.virtual_editor;
    diagnostics_panel.content.model.adapter = this.adapter;
    diagnostics_panel.update();
  };

  protected collapse_overlapping_diagnostics(
    diagnostics: lsProtocol.Diagnostic[]
  ): Map<lsProtocol.Range, lsProtocol.Diagnostic[]> {
    // because Range is not a primitive type, the equality of the objects having
    // the same parameters won't be compared (thus considered equal) in Map.

    // instead, a intermediate step of mapping through a stringified representation of Range is needed:
    // an alternative would be using nested [start line][start character][end line][end character] structure,
    // which would increase the code complexity, but reduce memory use and may be slightly faster.
    type RangeID = string;
    const range_id_to_range = new Map<RangeID, lsProtocol.Range>();
    const range_id_to_diagnostics = new Map<RangeID, lsProtocol.Diagnostic[]>();

    function get_range_id(range: lsProtocol.Range): RangeID {
      return (
        range.start.line +
        ',' +
        range.start.character +
        ',' +
        range.end.line +
        ',' +
        range.end.character
      );
    }

    diagnostics.forEach((diagnostic: lsProtocol.Diagnostic) => {
      let range = diagnostic.range;
      let range_id = get_range_id(range);
      range_id_to_range.set(range_id, range);
      if (range_id_to_diagnostics.has(range_id)) {
        let ranges_list = range_id_to_diagnostics.get(range_id);
        ranges_list.push(diagnostic);
      } else {
        range_id_to_diagnostics.set(range_id, [diagnostic]);
      }
    });

    let map = new Map<lsProtocol.Range, lsProtocol.Diagnostic[]>();

    range_id_to_diagnostics.forEach(
      (range_diagnostics: lsProtocol.Diagnostic[], range_id: RangeID) => {
        let range = range_id_to_range.get(range_id);
        map.set(range, range_diagnostics);
      }
    );

    return map;
  }

  get defaultSeverity(): lsProtocol.DiagnosticSeverity {
    return DiagnosticSeverity[this.settings.composite.defaultSeverity];
  }

  private filterDiagnostics(
    diagnostics: lsProtocol.Diagnostic[]
  ): lsProtocol.Diagnostic[] {
    const ignoredDiagnosticsCodes = new Set(
      this.settings.composite.ignoreCodes
    );
    const ignoredMessagesRegExp = this.settings.composite.ignoreMessagesPatterns.map(
      pattern => new RegExp(pattern)
    );

    return diagnostics.filter(diagnostic => {
      let code = diagnostic.code;
      if (
        typeof code !== 'undefined' &&
        ignoredDiagnosticsCodes.has(code.toString())
      ) {
        return false;
      }
      let message = diagnostic.message;
      if (
        message &&
        ignoredMessagesRegExp.some(pattern => pattern.test(message))
      ) {
        return false;
      }
      return true;
    });
  }

  public handleDiagnostic = (response: lsProtocol.PublishDiagnosticsParams) => {
    if (!uris_equal(response.uri, this.virtual_document.document_info.uri)) {
      return;
    }

    if (this.virtual_document.last_virtual_line === 0) {
      return;
    }

    /* TODO: gutters */
    try {
      let diagnostics_list: IEditorDiagnostic[] = [];

      // Note: no deep equal for Sets or Maps in JS
      const markers_to_retain: Set<string> = new Set();

      // add new markers, keep track of the added ones

      // TODO: test case for severity class always being set, even if diagnostic has no severity

      let diagnostics_by_range = this.collapse_overlapping_diagnostics(
        this.filterDiagnostics(response.diagnostics)
      );

      diagnostics_by_range.forEach(
        (diagnostics: lsProtocol.Diagnostic[], range: lsProtocol.Range) => {
          const start = PositionConverter.lsp_to_cm(
            range.start
          ) as IVirtualPosition;
          const end = PositionConverter.lsp_to_cm(
            range.end
          ) as IVirtualPosition;
          const last_line_number = this.virtual_document.last_virtual_line;
          if (start.line > last_line_number) {
            console.log(
              `Out of range diagnostic (${start.line} line > ${last_line_number}) was skipped `,
              diagnostics
            );
            return;
          } else {
            let last_line = this.virtual_document.last_line;
            if (
              start.line == this.virtual_document.last_virtual_line &&
              start.ch > last_line.length
            ) {
              console.log(
                `Out of range diagnostic (${start.ch} character > ${last_line.length} at line ${last_line_number}) was skipped `,
                diagnostics
              );
              return;
            }
          }

          let document: VirtualDocument;
          try {
            // assuming that we got a response for this document
            let start_in_root = this.transform_virtual_position_to_root_position(
              start
            );
            document = this.virtual_editor.document_at_root_position(
              start_in_root
            );
          } catch (e) {
            console.log(e, diagnostics);
            return;
          }

          // This may happen if the response came delayed
          // and the user already changed the document so
          // that now this regions is in another virtual document!
          if (this.virtual_document !== document) {
            console.log(
              `Ignoring inspections from ${response.uri}`,
              ` (this region is covered by a another virtual document: ${document.uri})`,
              ` inspections: `,
              diagnostics
            );
            return;
          }

          if (
            document.virtual_lines
              .get(start.line)
              .skip_inspect.indexOf(document.id_path) !== -1
          ) {
            console.log(
              'Ignoring inspections silenced for this document:',
              diagnostics
            );
            return;
          }

          let highest_severity_code = diagnostics
            .map(diagnostic => diagnostic.severity || this.defaultSeverity)
            .sort()[0];

          const severity = DiagnosticSeverity[highest_severity_code];

          let ce_editor = document.get_editor_at_virtual_line(start);
          let cm_editor = this.virtual_editor.ce_editor_to_cm_editor.get(
            ce_editor
          );

          let start_in_editor = document.transform_virtual_to_editor(start);
          let end_in_editor: IEditorPosition;

          // some servers return strange positions for ends
          try {
            end_in_editor = document.transform_virtual_to_editor(end);
          } catch (err) {
            console.warn('LSP: Malformed range for diagnostic', end);
            end_in_editor = { ...start_in_editor, ch: start_in_editor.ch + 1 };
          }

          let range_in_editor = {
            start: start_in_editor,
            end: end_in_editor
          };
          // what a pity there is no hash in the standard library...
          // we could use this: https://stackoverflow.com/a/7616484 though it may not be worth it:
          //   the stringified diagnostic objects are only about 100-200 JS characters anyway,
          //   depending on the message length; this could be reduced using some structure-aware
          //   stringifier; such a stringifier could also prevent the possibility of having a false
          //   negative due to a different ordering of keys
          // obviously, the hash would prevent recovery of info from the key.
          let diagnostic_hash = JSON.stringify({
            // diagnostics without ranges
            diagnostics: diagnostics.map(diagnostic => [
              diagnostic.severity,
              diagnostic.message,
              diagnostic.code,
              diagnostic.source,
              diagnostic.relatedInformation
            ]),
            // the apparent marker position will change in the notebook with every line change for each marker
            // after the (inserted/removed) line - but such markers should not be invalidated,
            // i.e. the invalidation should be performed in the cell space, not in the notebook coordinate space,
            // thus we transform the coordinates and keep the cell id in the hash
            range: range_in_editor,
            editor: this.unique_editor_ids.get(cm_editor)
          });
          for (let diagnostic of diagnostics) {
            diagnostics_list.push({
              diagnostic,
              editor: cm_editor,
              range: range_in_editor
            });
          }

          markers_to_retain.add(diagnostic_hash);

          if (!this.marked_diagnostics.has(diagnostic_hash)) {
            let options: CodeMirror.TextMarkerOptions = {
              title: diagnostics
                .map(d => d.message + (d.source ? ' (' + d.source + ')' : ''))
                .join('\n'),
              className: 'cm-lsp-diagnostic cm-lsp-diagnostic-' + severity
            };
            let marker;
            try {
              marker = cm_editor
                .getDoc()
                .markText(start_in_editor, end_in_editor, options);
            } catch (e) {
              console.warn(
                'Marking inspection (diagnostic text) failed, see following logs (2):'
              );
              console.log(diagnostics);
              console.log(e);
              return;
            }
            this.marked_diagnostics.set(diagnostic_hash, marker);
          }
        }
      );

      // remove the markers which were not included in the new message
      this.remove_unused_diagnostic_markers(markers_to_retain);

      this.diagnostics_db.set(this.virtual_document, diagnostics_list);
      diagnostics_panel.update();
    } catch (e) {
      console.warn(e);
    }
  };

  protected remove_unused_diagnostic_markers(to_retain: Set<string>) {
    this.marked_diagnostics.forEach(
      (marker: CodeMirror.TextMarker, diagnostic_hash: string) => {
        if (!to_retain.has(diagnostic_hash)) {
          this.marked_diagnostics.delete(diagnostic_hash);
          marker.clear();
        }
      }
    );
  }

  remove(): void {
    // remove all markers
    this.remove_unused_diagnostic_markers(new Set());
    this.diagnostics_db.clear();
    diagnostics_databases.delete(this.virtual_editor);
    this.unique_editor_ids.clear();

    if (
      diagnostics_panel.content.model.virtual_editor === this.virtual_editor
    ) {
      diagnostics_panel.content.model.virtual_editor = null;
      diagnostics_panel.content.model.diagnostics = null;
      diagnostics_panel.content.model.adapter = null;
    }

    diagnostics_panel.update();
    super.remove();
  }
}
