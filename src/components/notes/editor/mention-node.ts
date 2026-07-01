import {
  $applyNodeReplacement,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";
import { ENTITY_PREFIX, isEntityType, type EntityType } from "@/lib/mentions/refs";

/**
 * A `@mention` of ANY entity (person, work item, project, note, …). Renders as
 * `<prefix><label>` (a styled, non-editable token) but its canonical storage
 * form is the app's token: `<@uuid>` for a person (back-compat) or
 * `<@type:id>` for every other entity. The markdown round-trip lives in
 * `./markdown.ts` (`mentionTransformer`).
 *
 * Extends TextNode (not DecoratorNode) so it composes with the markdown
 * text-match transformer pipeline and behaves like an atomic word.
 */
export type SerializedMentionNode = Spread<
  { mentionType: string; mentionId: string; mentionName: string },
  SerializedTextNode
>;

export class MentionNode extends TextNode {
  __entityType: EntityType;
  __id: string;
  __name: string;

  static getType(): string {
    return "mention";
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(
      node.__entityType,
      node.__id,
      node.__name,
      node.__text,
      node.__key,
    );
  }

  constructor(
    entityType: EntityType,
    id: string,
    name: string,
    text?: string,
    key?: NodeKey,
  ) {
    super(text ?? `${ENTITY_PREFIX[entityType]}${name}`, key);
    this.__entityType = entityType;
    this.__id = id;
    this.__name = name;
  }

  getId(): string {
    return this.__id;
  }

  getEntityType(): EntityType {
    return this.__entityType;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.className =
      "inline-block rounded bg-accent px-1 text-xs font-medium align-baseline";
    dom.setAttribute("data-mention", this.__id);
    dom.setAttribute("data-mention-type", this.__entityType);
    return dom;
  }

  static importJSON(serialized: SerializedMentionNode): MentionNode {
    const type = isEntityType(serialized.mentionType)
      ? serialized.mentionType
      : "user"; // legacy person mentions had no type
    const node = $createMentionNode(type, serialized.mentionId, serialized.mentionName);
    node.setTextContent(serialized.text);
    node.setFormat(serialized.format);
    node.setStyle(serialized.style);
    return node;
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      type: "mention",
      version: 1,
      mentionType: this.__entityType,
      mentionId: this.__id,
      mentionName: this.__name,
    };
  }

  isTextEntity(): true {
    return true;
  }

  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }
}

export function $createMentionNode(
  entityType: EntityType,
  id: string,
  name: string,
): MentionNode {
  const node = new MentionNode(entityType, id, name);
  // `token` mode: the node is selected/deleted as one atomic unit.
  node.setMode("token");
  return $applyNodeReplacement(node);
}

export function $isMentionNode(
  node: LexicalNode | null | undefined,
): node is MentionNode {
  return node instanceof MentionNode;
}
