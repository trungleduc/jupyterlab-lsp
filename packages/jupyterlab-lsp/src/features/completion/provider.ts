import { CodeEditor } from '@jupyterlab/codeeditor';
import {
  Completer,
  CompletionHandler,
  ICompletionContext,
  ICompletionProvider
} from '@jupyterlab/completer';
import { LabIcon } from '@jupyterlab/ui-components';
import {
  ILSPCompletionThemeManager,
  KernelKind
} from '@krassowski/completion-theme/lib/types';
import { CompletionTriggerKind } from 'vscode-languageserver-protocol';
import * as lsProtocol from 'vscode-languageserver-types';

import { LSPConnection } from '../../connection';
import { PositionConverter } from '../../converter';
import { CompletionItemKind } from '../../lsp';
import {
  IEditorPosition,
  IRootPosition,
  IVirtualPosition
} from '../../positioning';
import { VirtualDocument } from '../../virtual/document';
import { IVirtualEditor } from '../../virtual/editor';

import { ICompletionsReply } from './completion_handler';
import { IExtendedCompletionItem, LazyCompletionItem } from './item';
import { LSPCompletionRenderer } from './renderer';

export class LspCompletionProvider implements ICompletionProvider {
  constructor(options: LspCompletionProvider.IOptions) {
    this.renderer = options.renderer;
    this.virtual_editor = options.virtual_editor;
    this.themeManager = options.themeManager;
    this._connections = options.connections;
  }
  update(options: {
    virtual_editor?: IVirtualEditor<CodeEditor.IEditor>;
    connections?: Map<VirtualDocument.uri, LSPConnection>;
  }) {
    this.virtual_editor = options.virtual_editor ?? this.virtual_editor;
    this._connections = options.connections ?? this._connections;
  }
  async isApplicable(context: ICompletionContext): Promise<boolean> {
    return !!context.editor;
  }
  async fetch(
    request: CompletionHandler.IRequest,
    context: ICompletionContext
  ): Promise<
    CompletionHandler.ICompletionItemsReply<CompletionHandler.ICompletionItem>
  > {
    if (!this.virtual_editor || !this._connections) {
      return { start: 0, end: 0, items: [] };
    }
    const editor = context.editor! as any;

    const cursor = editor.getCursorPosition();
    const token = editor.getTokenForPosition(cursor);

    const start = editor.getPositionAt(token.offset)!;
    const end = editor.getPositionAt(token.offset + token.value.length)!;

    let position_in_token = cursor.column - start.column - 1;
    const typed_character = token.value[cursor.column - start.column - 1];

    let start_in_root = this.transform_from_editor_to_root(editor, start);
    let end_in_root = this.transform_from_editor_to_root(editor, end);
    let cursor_in_root = this.transform_from_editor_to_root(editor, cursor);

    let virtual_editor = this.virtual_editor;

    // find document for position
    let document = virtual_editor.document_at_root_position(start_in_root);

    let virtual_start =
      virtual_editor.root_position_to_virtual_position(start_in_root);
    let virtual_end =
      virtual_editor.root_position_to_virtual_position(end_in_root);
    let virtual_cursor =
      virtual_editor.root_position_to_virtual_position(cursor_in_root);
    const lsp_promise: Promise<
      CompletionHandler.ICompletionItemsReply | undefined
    > = this.fetch_lsp(
      token,
      typed_character,
      virtual_start,
      virtual_end,
      virtual_cursor,
      document,
      position_in_token
    );

    let promise = Promise.all([lsp_promise.catch(p => p)]).then(([lsp]) => {
      let replies = [];
      if (lsp != null) {
        replies.push(lsp);
      }
      return this.merge_replies(replies, editor);
    });

    return promise.then(reply => {
      const newReply = this.suppress_if_needed(editor, reply, token, cursor);
      return newReply ?? reply;
    });
  }

  async resolve(
    completionItem: LazyCompletionItem,
    context: ICompletionContext,
    patch?: Completer.IPatch | null
  ): Promise<LazyCompletionItem> {
    const resolvedCompletionItem = await completionItem.lspResolve();
    console.log(
      'completionItem',
      resolvedCompletionItem.label,
      resolvedCompletionItem.documentation
    );

    return {
      ...completionItem,
      documentation: resolvedCompletionItem.documentation
    } as any;
  }
  transform_from_editor_to_root(
    editor: CodeEditor.IEditor,
    position: CodeEditor.IPosition
  ): IRootPosition {
    let editor_position = PositionConverter.ce_to_cm(
      position
    ) as IEditorPosition;
    return this.virtual_editor!.transform_from_editor_to_root(
      editor,
      editor_position
    )!;
  }

  private suppress_if_needed(
    editor: CodeEditor.IEditor,
    reply: CompletionHandler.ICompletionItemsReply | undefined,
    token: CodeEditor.IToken,
    cursor_at_request: CodeEditor.IPosition
  ) {
    if (reply == null) {
      return reply;
    }
    if (!editor.hasFocus()) {
      console.debug(
        'Ignoring completion response: the corresponding editor lost focus'
      );
      return {
        start: reply.start,
        end: reply.end,
        items: []
      };
    }
    return reply;
  }

  protected merge_replies(
    replies: ICompletionsReply[],
    editor: CodeEditor.IEditor
  ): ICompletionsReply {
    console.log('Merging completions:', replies);

    replies = replies.filter(reply => {
      if (reply instanceof Error) {
        console.log(`Caught ${reply.source!.name} completions error`, reply);
        return false;
      }
      // ignore if no matches
      if (!reply.items.length) {
        return false;
      }
      // otherwise keep
      return true;
    });

    replies.sort((a, b) => b.source!.priority - a.source!.priority);

    console.log('Sorted replies:', replies);

    const minEnd = Math.min(...replies.map(reply => reply.end));

    // if any of the replies uses a wider range, we need to align them
    // so that all responses use the same range
    const minStart = Math.min(...replies.map(reply => reply.start));
    const maxStart = Math.max(...replies.map(reply => reply.start));

    if (minStart != maxStart) {
      const cursor = editor.getCursorPosition();
      const line = editor.getLine(cursor.line);
      if (line == null) {
        console.log(
          `Could not remove prefixes: line is undefined`,
          cursor.line
        );
      } else {
        replies = replies.map(reply => {
          // no prefix to strip, return as-is
          if (reply.start == maxStart) {
            return reply;
          }
          let prefix = line.substring(reply.start, maxStart);
          console.log(`Removing ${reply.source!.name} prefix: `, prefix);
          return {
            ...reply,
            items: reply.items.map(item => {
              item.insertText = item.insertText.startsWith(prefix)
                ? item.insertText.substr(prefix.length)
                : item.insertText;
              return item;
            })
          };
        });
      }
    }

    const insertTextSet = new Set<string>();
    const processedItems = new Array<IExtendedCompletionItem>();

    for (const reply of replies) {
      reply.items.forEach(item => {
        // trimming because:
        // IPython returns 'import' and 'import '; while the latter is more useful,
        // user should not see two suggestions with identical labels and nearly-identical
        // behaviour as they could not distinguish the two either way
        let text = item.insertText.trim();
        if (insertTextSet.has(text)) {
          return;
        }
        insertTextSet.add(text);
        // extra processing (adding icon/source name) is delayed until
        // we are sure that the item will be kept (as otherwise it could
        // lead to processing hundreds of suggestions - e.g. from numpy
        // multiple times if multiple sources provide them).
        let processedItem = item as IExtendedCompletionItem;
        if (reply.source) {
          processedItem.source = reply.source;
          if (!processedItem.icon) {
            processedItem.icon = reply.source.fallbackIcon as any;
          }
        }
        processedItems.push(processedItem);
      });
    }

    // Return reply with processed items.
    console.debug('Merged: ', processedItems);
    return {
      start: maxStart,
      end: minEnd,
      source: null,
      items: processedItems
    };
  }
  public get_connection(uri: string) {
    if (!this._connections) {
      return;
    }
    return this._connections.get(uri);
  }
  async fetch_lsp(
    token: CodeEditor.IToken,
    typed_character: string,
    start: IVirtualPosition,
    end: IVirtualPosition,
    cursor: IVirtualPosition,
    document: VirtualDocument,
    position_in_token: number
  ): Promise<ICompletionsReply> {
    let connection = this.get_connection(document.uri)!;

    const trigger_kind = CompletionTriggerKind.Invoked;

    let lspCompletionItems = ((await connection.getCompletion(
      cursor,
      {
        start,
        end,
        text: token.value
      },
      document.document_info,
      false,
      typed_character,
      trigger_kind
    )) || []) as lsProtocol.CompletionItem[];

    console.debug('Transforming');
    let prefix = token.value.slice(0, position_in_token + 1);
    let all_non_prefixed = true;
    let items: IExtendedCompletionItem[] = [];
    lspCompletionItems.forEach(match => {
      let kind = match.kind ? CompletionItemKind[match.kind] : '';

      // Update prefix values
      let text = match.insertText ? match.insertText : match.label;

      // declare prefix presence if needed and update it
      if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
        all_non_prefixed = false;
        if (prefix !== token.value) {
          if (text.toLowerCase().startsWith(token.value.toLowerCase())) {
            // given a completion insert text "display_table" and two test cases:
            // disp<tab>data →  display_table<cursor>data
            // disp<tab>lay  →  display_table<cursor>
            // we have to adjust the prefix for the latter (otherwise we would get display_table<cursor>lay),
            // as we are constrained NOT to replace after the prefix (which would be "disp" otherwise)
            prefix = token.value;
          }
        }
      }
      // add prefix if needed
      else if (token.type === 'string' && prefix.includes('/')) {
        // special case for path completion in strings, ensuring that:
        //     '/Com<tab> → '/Completion.ipynb
        // when the returned insert text is `Completion.ipynb` (the token here is `'/Com`)
        // developed against pyls and pylsp server, may not work well in other cases
        const parts = prefix.split('/');
        if (
          text.toLowerCase().startsWith(parts[parts.length - 1].toLowerCase())
        ) {
          let pathPrefix = parts.slice(0, -1).join('/') + '/';
          match.insertText = pathPrefix + match.insertText;
          // for label removing the prefix quote if present
          if (pathPrefix.startsWith("'") || pathPrefix.startsWith('"')) {
            pathPrefix = pathPrefix.substr(1);
          }
          match.label = pathPrefix + match.label;
          all_non_prefixed = false;
        }
      }

      let completionItem = new LazyCompletionItem(
        kind,
        this.icon_for(kind),
        match,
        this,
        document.uri
      );

      items.push(completionItem as any);
    });
    console.debug('Transformed');
    // required to make the repetitive trigger characters like :: or ::: work for R with R languageserver,
    // see https://github.com/jupyter-lsp/jupyterlab-lsp/issues/436
    let prefix_offset = token.value.length;
    // completion of dictionaries for Python with jedi-language-server was
    // causing an issue for dic['<tab>'] case; to avoid this let's make
    // sure that prefix.length >= prefix.offset
    if (all_non_prefixed && prefix_offset > prefix.length) {
      prefix_offset = prefix.length;
    }

    let response = {
      // note in the ContextCompleter it was:
      // start: token.offset,
      // end: token.offset + token.value.length,
      // which does not work with "from statistics import <tab>" as the last token ends at "t" of "import",
      // so the completer would append "mean" as "from statistics importmean" (without space!);
      // (in such a case the typedCharacters is undefined as we are out of range)
      // a different workaround would be to prepend the token.value prefix:
      // text = token.value + text;
      // but it did not work for "from statistics <tab>" and lead to "from statisticsimport" (no space)
      start: token.offset + (all_non_prefixed ? prefix_offset : 0),
      end: token.offset + prefix.length,
      items: items,
      source: {
        name: 'LSP',
        priority: 2
      }
    };
    if (response.start > response.end) {
      console.warn(
        'Response contains start beyond end; this should not happen!',
        response
      );
    }

    return response;
  }
  protected icon_for(type: string): LabIcon {
    if (typeof type === 'undefined') {
      type = KernelKind;
    }
    return (this.themeManager.get_icon(type) as LabIcon) || undefined;
  }
  public should_show_documentation = true;
  identifier = 'LspCompletionProvider';
  renderer:
    | Completer.IRenderer<CompletionHandler.ICompletionItem>
    | null
    | undefined;
  private virtual_editor: IVirtualEditor<CodeEditor.IEditor> | undefined;
  private themeManager: ILSPCompletionThemeManager;
  private _connections: Map<VirtualDocument.uri, LSPConnection> | undefined;
}

export namespace LspCompletionProvider {
  export interface IOptions {
    renderer: LSPCompletionRenderer;
    virtual_editor: IVirtualEditor<CodeEditor.IEditor> | undefined;
    connections: Map<VirtualDocument.uri, LSPConnection> | undefined;
    themeManager: ILSPCompletionThemeManager;
  }
}
