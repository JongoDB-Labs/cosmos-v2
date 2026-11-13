// @vitest-environment node
//
// A write that names a row by id (a partner, a parent, a sprint, a person) has
// to be checked against the caller's org before it is stored: the foreign keys
// are single-column, so the database takes another tenant's id as readily as
// the caller's own. That was missed route by route, so this scan makes it a
// decision for every new one.
//
// WHAT COUNTS AS A FIELD. Every key of a zod object a write accepts, where:
//   - the key ends in Id/Ids or _id/_ids (any name, not a fixed list);
//   - or its value is a uuid (`z.string().uuid()`, `Uuid`, a list of them);
//   - or it holds a Prisma relation write (`connect`, `set`, ...).
// A plain `id` is the row being acted on, not a reference to another.
//
// WHERE. Each API route's write handlers (POST, PUT, PATCH, DELETE) and every
// assistant tool. A schema is followed wherever it is declared: in the file,
// in its route.contract.ts (the request body only), or in a shared module such
// as lib/openapi/schemas. Query strings a write handler reads with
// `searchParams.get(...)` count too.
//
// WHAT COUNTS AS CHECKED, per field rather than per file:
//   - a checker call whose arguments name THIS field: the shared helper
//     (lib/rbac/foreign-refs.ts, its refs argument only) or one in NAMED;
//   - a Prisma lookup of the field's row inside the org: `where: { id: b.x, orgId }`;
//   - a person looked up among the org's members: `orgMember.count({ where: { orgId, userId: … } })`;
//   - a DEDICATED checker, written for that field, being called at all.
// A local built from the field counts as the field (`const ids = [...body.labelIds]`),
// but not one holding what a query returned.
// The route's own path parameter does not stand in for a body field of the
// same name. A route that hands its body to a service is checked where VIA
// says the service checks it. Anything else is listed in INLINE with how it is
// checked or why it is not a reference to a row, or in KNOWN_GAPS.
//
// Parsed with the TypeScript compiler, so a word in a comment or a string is
// never a field or a check. What it still cannot see: whether a check REFUSES
// (the database tests do: foreign-ids*.db.test.ts, foreign-refs.db.test.ts,
// member-refs.db.test.ts), a body read without zod, and a nested `id`.
import { describe, expect, it } from "vitest";
import { existsSync, globSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import ts from "typescript";

type Read = (path: string) => string | undefined;
const disk: Read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);

const API = "src/app/api/v1/orgs/[orgId]/";
const EXE = "src/lib/ai/executors/";

/** A key that names another row. */
const REF_KEY = /(?:Id|Ids|_id|_ids)$/;
/** A uuid-valued schema, written out or by a common constant's name. */
const UUID = /\.uuid\(|\bz\.uuid\(|\b\w*Uuid\w*\b/;
/** Prisma's nested relation writes: a body key holding one names rows too. */
const RELATION_WRITE = new Set(["connect", "connectOrCreate", "set", "disconnect"]);
/** Calls whose first argument is a schema's shape. */
const SHAPE_CALL = new Set(["object", "strictObject", "looseObject", "extend"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The shared helper, by the position of its refs argument. Only that argument
 * checks anything: a projectId in the scope argument narrows the refs and is
 * itself taken on trust.
 */
const REFS_ARG: Record<string, number> = { assertRefsInScope: 1, refsError: 1, foreignRef: 2 };

/**
 * Checkers that hold the id they are handed to the caller's org, and count
 * for whichever field their arguments name.
 */
const NAMED = new Set([
  // A project: visible to the caller (team scoping and a key's ceiling), in the org.
  "requireProjectVisible", "requireProjectVisibleIf", "requireProjectRead", "requireProjectManage",
  "assertProjectRead", "assertProjectManage", "canAttachToProject",
  // A team: one of this project's.
  "teamProjectError",
  // A person: a current member of the org.
  "assertAssigneesInOrg", "assignableMembersWhere", "assertOrgMember", "allOrgMembers", "editorProblem",
  "loadMemberAuthContext",
  // A row looked up within the org and project, or null.
  "loadCeremony", "resolvePmSubject", "resolveLinkSubject",
]);

/**
 * Checkers that take a whole body and are written for these fields, so a
 * call is enough. Read one before adding a field to its list: it must hold
 * that field to the org.
 */
const DEDICATED: Record<string, string[]> = {
  projectId: ["assertBillLinks", "visibilityProblem"],
  invoiceId: ["assertBillLinks"],
  partnerId: ["assertBillLinks"],
  contractId: ["assertDeliverableLinks"],
  intervalId: ["assertDeliverableLinks", "assertMilestoneInterval"],
  teamId: ["visibilityProblem", "subscriptionProblem"],
  parentId: ["resolveReplyParent"],
  boardId: ["requireBoardRead"],
};

/**
 * A route or tool that calls one of these is checked in the module named:
 * the scan reads that module's checks as the caller's own.
 */
const VIA: Record<string, string> = {
  applyWorkItemChange: "src/lib/work-items/apply-change.server.ts",
  createWorkItemRow: "src/lib/work-items/write.server.ts",
  updateItem: `${API}projects/[projectId]/work-items/[itemId]/route.ts`,
  createInvoice: "src/lib/invoicing/service.ts",
  updateInvoice: "src/lib/invoicing/service.ts",
  createEmployee: "src/lib/payroll/service.ts",
  matchTransaction: "src/lib/bank/reconcile.ts",
  createProgramEvent: "src/lib/program-calendar/service.ts",
  updateProgramEvent: "src/lib/program-calendar/service.ts",
  assignWorkflow: "src/lib/workflow/versions.server.ts",
  createWorkflow: "src/lib/workflow/versions.server.ts",
  // One function behind each REST route and its assistant tool.
  getBoard: "src/lib/boards/board-service.server.ts",
  updateBoard: "src/lib/boards/board-service.server.ts",
  replaceBoardColumns: "src/lib/boards/board-service.server.ts",
  deleteBoard: "src/lib/boards/board-service.server.ts",
  getCeremonyPayload: "src/lib/intervals/ceremony.server.ts",
  listCeremonyBoards: "src/lib/intervals/ceremony.server.ts",
  openCeremony: "src/lib/intervals/ceremony.server.ts",
  closeCeremony: "src/lib/intervals/ceremony.server.ts",
  addCeremonyNote: "src/lib/intervals/ceremony.server.ts",
  updateCeremonyNote: "src/lib/intervals/ceremony.server.ts",
  deleteCeremonyNote: "src/lib/intervals/ceremony.server.ts",
  addCeremonyAction: "src/lib/intervals/ceremony.server.ts",
  updateCeremonyAction: "src/lib/intervals/ceremony.server.ts",
  deleteCeremonyAction: "src/lib/intervals/ceremony.server.ts",
  promoteCeremonyAction: "src/lib/intervals/ceremony.server.ts",
  addTeamMember: "src/lib/projects/membership.server.ts",
  removeTeamMember: "src/lib/projects/membership.server.ts",
  createSavedView: "src/lib/query/saved-view-service.server.ts",
  updateSavedView: "src/lib/query/saved-view-service.server.ts",
  deleteSavedView: "src/lib/query/saved-view-service.server.ts",
  createObjectiveDependency: "src/lib/okr/dependencies.server.ts",
};

const READ = "a read: it filters a query run within the caller's own visibility, and stores nothing";
const CQL_CONTEXT =
  "a read: the query's 'this project', honoured only when the caller can read it (lib/query/resolve.server.ts); nothing is stored";
const IGNORED_BOARD = "accepted and unused: the workflow gate takes a board id and reads nothing from it";
const SKIP_LIST = "a skip list: it only leaves items out of the schedule cascade, which walks this project's own dependents";
const INVOICE_TAG =
  "createInvoice refuses a re-billed line; updateInvoice keeps one only if this invoice already has it (reconcileReimbursableLines)";

/**
 * Pairs checked some other way than one the scan recognises, and pairs that
 * are not a reference to a row at all. Each says which.
 */
const INLINE: Record<string, Record<string, string>> = {
  "src/app/api/admin/auth-providers/route.ts": { clientId: "an OAuth app's client id at the identity provider, not a row" },
  [`${API}agent-policy/route.ts`]: {
    allowedProjectIds: "an allowlist that only narrows what the assistant may touch: an id that isn't the org's own project matches nothing",
  },
  [`${API}api-keys/route.ts`]: {
    projectIds: "inline: each must be among getVisibleProjectIds, this org's projects the caller can see, or the key is refused",
  },
  [`${API}chat/channels/[channelId]/messages/route.ts`]: {
    attachmentIds: "createUserMessage (lib/chat/messages.ts) attaches only the author's own uploads not yet on a message",
    parentMessageId: "createUserMessage (lib/chat/messages.ts) requires the parent in the same channel",
  },
  [`${API}chat/channels/[channelId]/pins/route.ts`]: { messageId: "inline: looked up as { id, channelId } in this org's channel" },
  [`${API}compliance/controls/route.ts`]: { controlId: "a control's code in a compliance framework, not a row id" },
  [`${API}cql/predicate/route.ts`]: { contextProjectId: CQL_CONTEXT },
  [`${API}cql/validate/route.ts`]: { contextProjectId: CQL_CONTEXT },
  [`${API}dashboards/preview-panel/route.ts`]: { contextProjectId: CQL_CONTEXT },
  [`${API}employees/[employeeId]/supervisors/route.ts`]: {
    supervisorIds: "inline: each one added must be among supervisorPickerOptions' addable ids, all members of this org",
  },
  [`${API}employees/bulk/route.ts`]: { userIds: "createEmployeesForMembers (lib/payroll/service.ts) keeps only the org's members" },
  [`${API}feedback/remediation-config/route.ts`]: {
    defaultProjectId: "inline: must be one of the org's live projects the caller can see",
    projectIds: "inline: each must be one of the org's live projects the caller can see",
  },
  [`${API}invoices/[invoiceId]/reimbursables/route.ts`]: {
    billIds: "addReimbursables keeps only picks among the invoice project's unbilled costs",
    expenseIds: "addReimbursables keeps only picks among the invoice project's unbilled costs",
  },
  [`${API}invoices/[invoiceId]/route.ts`]: { billId: INVOICE_TAG, expenseId: INVOICE_TAG },
  [`${API}invoices/route.ts`]: { billId: INVOICE_TAG, expenseId: INVOICE_TAG },
  [`${API}preferences/route.ts`]: {
    defaultBoardId: "the caller's own preference, followed only when it is one of the project's boards",
    skinId: "a skin preset's key, checked against the preset registry, not a row",
    themeId: "the caller's own preference, which nothing reads back",
  },
  [`${API}projects/[projectId]/documents/[docId]/convert/route.ts`]: { blockId: "a block inside this document's content, not a row" },
  [`${API}projects/[projectId]/tab-prefs/route.ts`]: {
    hiddenBoardIds: "the caller's own tab preference: it hides matching tabs, and an id that isn't one matches nothing",
  },
  [`${API}projects/[projectId]/work-items/[itemId]/route.ts`]: { boardId: IGNORED_BOARD, cascadeSkipIds: SKIP_LIST },
  [`${API}projects/[projectId]/work-items/import/route.ts`]: {
    workItemTypeId: "the import engine resolves types among the org's own and the built-in ones",
  },
  [`${API}projects/route.ts`]: { templateId: "inline: a built-in template or one of this org's" },
  [`${API}security/sessions/route.ts`]: { sessionIds: "inline: only this org's active sessions with these ids are revoked" },
  [`${API}security/settings/route.ts`]: { ssoConnectionId: "the connection's id at the SSO provider, not a row" },
  [`${API}supervisor-requests/route.ts`]: {
    supervisorEmployeeIds: "requestSupervisors (lib/org/supervisor-requests.ts) keeps only this org's eligible supervisors",
  },
  [`${API}theme/route.ts`]: { defaultSkinId: "a skin preset's key, checked against the preset registry, not a row" },
  [`${API}work-item-types/[typeId]/fields/route.ts`]: {
    customFieldId: "inline: the field's org must be this one, and its project visible to the caller",
  },
  [`${API}work-items/[itemId]/route.ts`]: { boardId: IGNORED_BOARD, cascadeSkipIds: SKIP_LIST },
  [`${API}work-items/aggregate/route.ts`]: { contextProjectId: CQL_CONTEXT },
  [`${API}work-items/query/route.ts`]: { contextProjectId: CQL_CONTEXT },
  [`${API}work-items/search/route.ts`]: {
    assigneeIds: READ, intervalIds: READ, parentIds: READ, projectIds: READ, typeIds: READ,
    watchedByUserId: "a read filter, and only the caller's own id is accepted",
  },
  [`${EXE}compliance.ts`]: { controlId: "a control's code, looked up by { orgId, controlId }" },
  [`${EXE}notes.ts`]: { projectId: "accepted and ignored: a note has no project" },
  [`${EXE}time.ts`]: { userId: "a read filter (list_time_entries), held to the people the caller may read" },
  [`${EXE}work-items.ts`]: {
    createdById: "a read filter (list_work_items) within a project the caller can read",
    transitionId: "matched among the transitions the workflow offers for this item",
  },
};

/**
 * Written unchecked today, and reported. Each is a real gap: an entry here is
 * debt, not an exemption, and leaves this list when it is fixed.
 */
const KNOWN_GAPS: Record<string, Record<string, string>> = {
  [`${API}chat/channels/[channelId]/read/route.ts`]: {
    messageId: "not yet held to this channel's messages; it sets only the caller's own read position",
  },
  [`${API}projects/[projectId]/intervals/[intervalId]/capacity/route.ts`]: {
    userId: "not yet held to the org's members",
  },
  [`${API}templates/[templateId]/widgets/route.ts`]: {
    parentWidgetId: "not yet held to the same template's widgets",
  },
};

// ─── The scanner ────────────────────────────────────────────────────────────

class Sources {
  private parsed = new Map<string, ts.SourceFile | null>();
  constructor(private read: Read) {}

  get(path: string): ts.SourceFile | null {
    if (!this.parsed.has(path)) {
      const text = this.read(path);
      const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      this.parsed.set(path, text === undefined ? null : ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind));
    }
    return this.parsed.get(path)!;
  }

  /** An `@/…` or relative import, to the file it names; null for a package. */
  resolve(from: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
    else if (spec.startsWith(".")) base = posix.normalize(posix.join(posix.dirname(from), spec));
    else return null;
    for (const p of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
      if (/\.tsx?$/.test(p) && this.get(p)) return p;
    }
    return null;
  }
}

/** A record's own entry: `VIA["toString"]` is not a service. */
const own = <T>(rec: Record<string, T>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined);

/** The text of a property key: a name, a quoted name or a computed literal. */
function keyName(name: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const e = name.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return null;
}

const calleeName = (call: ts.CallExpression): string | null =>
  ts.isIdentifier(call.expression) ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;

const isFunction = (n: ts.Node) => ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);

const squash = (n: ts.Node) => n.getText().replace(/\s+/g, " ");

/** Whether any node under root (root included) passes. */
function some(root: ts.Node, test: (n: ts.Node) => boolean): boolean {
  let hit = false;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (test(n)) hit = true;
    else ts.forEachChild(n, visit);
  };
  visit(root);
  return hit;
}

/** The object literal a shape call is given, if it is one. */
function shapeOf(n: ts.Node): ts.ObjectLiteralExpression | null {
  if (!ts.isCallExpression(n) || !SHAPE_CALL.has(calleeName(n) ?? "")) return null;
  const arg = n.arguments[0];
  return arg && ts.isObjectLiteralExpression(arg) ? arg : null;
}

/** A top-level `const name = …` initializer, or `function name`. */
function topLevel(sf: ts.SourceFile, name: string): ts.Node | null {
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return d.initializer ?? null;
      }
    }
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
  }
  return null;
}

/** Where an imported name comes from: `import { name }` or `export { name } from`. */
function importOf(sf: ts.SourceFile, name: string): { spec: string; imported: string } | null {
  for (const st of sf.statements) {
    const decl = ts.isImportDeclaration(st) || ts.isExportDeclaration(st) ? st : null;
    if (!decl?.moduleSpecifier || !ts.isStringLiteral(decl.moduleSpecifier)) continue;
    const named = ts.isImportDeclaration(decl) ? decl.importClause?.namedBindings : decl.exportClause;
    if (!named || !(ts.isNamedImports(named) || ts.isNamedExports(named))) continue;
    for (const el of named.elements) {
      if (el.name.text === name) return { spec: decl.moduleSpecifier.text, imported: (el.propertyName ?? el.name).text };
    }
  }
  return null;
}

/** A name's top-level definition, following imports and re-exports into other modules. */
function definition(srcs: Sources, file: string, name: string, hops = 0): { file: string; node: ts.Node } | null {
  const sf = srcs.get(file);
  if (!sf || hops > 6) return null;
  const local = topLevel(sf, name);
  if (local) return { file, node: local };
  const imp = importOf(sf, name);
  if (!imp) return null;
  const target = srcs.resolve(file, imp.spec);
  return target ? definition(srcs, target, imp.imported, hops + 1) : null;
}

/** Whether an identifier here is a name being declared or a property key, not a use. */
function isDeclarationOrKey(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    (ts.isPropertyAssignment(p) && p.name === id) ||
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isVariableDeclaration(p) && p.name === id) ||
    (ts.isFunctionDeclaration(p) && p.name === id) ||
    (ts.isParameter(p) && p.name === id) ||
    (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) ||
    ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) ||
    ts.isTypeReferenceNode(p) || ts.isQualifiedName(p)
  );
}

// ── Fields ──

/** Identifiers a node uses, by name. */
function usedNames(root: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && !isDeclarationOrKey(n)) names.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return names;
}

/**
 * A uuid-valued schema: `z.string().uuid()`, `Uuid`, a list of either, or a
 * constant defined as one. An object schema is not: its own keys are fields.
 */
function uuidShaped(value: ts.Expression, srcs: Sources, file: string): boolean {
  const hasShape = (n: ts.Node) => some(n, (c) => shapeOf(c) !== null);
  if (hasShape(value)) return false;
  if (UUID.test(value.getText())) return true;
  for (const name of usedNames(value)) {
    const def = definition(srcs, file, name);
    if (def && !isFunction(def.node) && !hasShape(def.node) && UUID.test(def.node.getText())) return true;
  }
  return false;
}

/** Whether a value's schema holds a relation write: `{ connect: … }`, `{ set: … }`. */
const holdsRelationWrite = (value: ts.Node) =>
  some(value, (n) => !!shapeOf(n)?.properties.some((p) => !!p.name && RELATION_WRITE.has(keyName(p.name) ?? "")));

/** The reference field a schema property declares, if it declares one. */
function refField(prop: ts.ObjectLiteralElementLike, srcs: Sources, file: string): string | null {
  let key: string | null = null;
  let value: ts.Expression | undefined;
  if (ts.isPropertyAssignment(prop)) {
    key = keyName(prop.name);
    value = prop.initializer;
  } else if (ts.isShorthandPropertyAssignment(prop)) {
    key = prop.name.text;
    value = prop.name;
  }
  if (!key || !value) return null;
  if (REF_KEY.test(key)) return key;
  if (key !== "id" && uuidShaped(value, srcs, file)) return key;
  if (holdsRelationWrite(value)) return key;
  return null;
}

/**
 * Every reference field in the schemas a node reaches: shapes written in it,
 * and the constants it uses, followed into other modules. A `defineRoute`
 * contract contributes its request body only. Functions are followed only
 * within the file: an imported one is a service, and VIA's business.
 */
function collectFields(root: ts.Node, file: string, srcs: Sources, seen: Set<string>, out: Set<string>): void {
  const prop = (o: ts.Node | undefined, k: string) =>
    o && ts.isObjectLiteralExpression(o)
      ? o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && keyName(p.name) === k)?.initializer
      : undefined;
  const visit = (n: ts.Node, at: string) => {
    if (ts.isCallExpression(n) && calleeName(n) === "defineRoute") {
      const body = prop(prop(n.arguments[0], "request"), "body");
      if (body) visit(body, at);
      return;
    }
    for (const p of shapeOf(n)?.properties ?? []) {
      const f = refField(p, srcs, at);
      if (f) out.add(f);
    }
    if (ts.isIdentifier(n) && !isDeclarationOrKey(n) && !seen.has(`${at}#${n.text}`)) {
      seen.add(`${at}#${n.text}`);
      const def = definition(srcs, at, n.text);
      if (def && (!isFunction(def.node) || def.file === file)) visit(def.node, def.file);
    }
    ts.forEachChild(n, (c) => visit(c, at));
  };
  visit(root, file);
}

// ── Bindings: where a name's value came from ──

function findBinding(name: ts.BindingName, text: string): ts.Identifier | null {
  if (ts.isIdentifier(name)) return name.text === text ? name : null;
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    const hit = findBinding(el.name, text);
    if (hit) return hit;
  }
  return null;
}

/** The binding a name refers to, by lexical scope. */
function declarationOf(id: ts.Identifier): ts.Identifier | null {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      for (const p of n.parameters) {
        const hit = findBinding(p.name, id.text);
        if (hit) return hit;
      }
    }
    if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && ts.isVariableDeclarationList(n.initializer)) {
      for (const d of n.initializer.declarations) {
        const hit = findBinding(d.name, id.text);
        if (hit) return hit;
      }
    }
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
      for (const st of n.statements) {
        if (st.pos > id.pos) break;
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            const hit = findBinding(d.name, id.text);
            if (hit) return hit;
          }
        }
      }
    }
  }
  return null;
}

/** What a binding was initialised from; whether it was destructured, and under a `params` key. */
function origin(decl: ts.Identifier): { init?: ts.Expression; destructured: boolean; underParams: boolean } {
  let n: ts.Node = decl;
  let underParams = false;
  while (n.parent && (ts.isBindingElement(n.parent) || ts.isObjectBindingPattern(n.parent) || ts.isArrayBindingPattern(n.parent))) {
    n = n.parent;
    if (ts.isBindingElement(n) && n.propertyName && keyName(n.propertyName) === "params") underParams = true;
  }
  const vd = n.parent;
  // `for (const batch of chunk(ids))`: the loop variable comes from what is iterated.
  const loop = vd?.parent?.parent;
  const init = !vd || !ts.isVariableDeclaration(vd) ? undefined
    : loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) ? loop.expression : vd.initializer;
  return { init, destructured: n !== decl, underParams };
}

/**
 * Whether an expression holds the route's own path parameters, or one of
 * them: `params`, `await params`, `p.projectId` for `{ params: p } = parseRequest(…)`,
 * `projectId` for `{ projectId } = await params`. Checking that id says nothing
 * about a body field of the same name.
 */
function isParamsValue(e: ts.Expression, depth = 0): boolean {
  if (depth > 4) return false;
  if (/^\(?(?:await )?(?:\w+\.)?params\)?$/.test(squash(e))) return true;
  if (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isPropertyAccessExpression(e)) {
    return isParamsValue(e.expression, depth + 1);
  }
  if (!ts.isIdentifier(e)) return false;
  const decl = declarationOf(e);
  if (!decl) return false;
  const { init, underParams } = origin(decl);
  return underParams || (!!init && isParamsValue(init, depth + 1));
}

/** A local's initializer, when it is bound directly (not destructured): `const ids = …`. */
function localInit(id: ts.Identifier): ts.Expression | undefined {
  const decl = declarationOf(id);
  if (!decl) return undefined;
  const o = origin(decl);
  return o.destructured ? undefined : o.init;
}

/**
 * A local built from the field itself, `const ids = [...new Set(body.labelIds)]`,
 * and not from what a query returned: `const rows = await db.find({ where: { id: body.x } })`
 * holds rows, and a check of them is not a check of the field.
 */
function derivedInit(id: ts.Identifier): ts.Expression | undefined {
  const init = localInit(id);
  return init && !some(init, ts.isAwaitExpression) ? init : undefined;
}

/**
 * Whether a node names the field: `body.partnerId`, `partnerId`, `b["parent_id"]`,
 * a local built from it, or a same-file helper that reads it.
 */
function namesIn(root: ts.Node, field: string, sf: ts.SourceFile, depth = 0): boolean {
  return some(root, (n) => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === field) return !isParamsValue(n.expression);
    if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) && n.argumentExpression.text === field) {
      return !isParamsValue(n.expression);
    }
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === field) return !isParamsValue(n.name);
    if (ts.isIdentifier(n) && !isDeclarationOrKey(n)) {
      if (n.text === field) return !isParamsValue(n);
      const init = depth < 3 ? derivedInit(n) : undefined;
      return !!init && namesIn(init, field, sf, depth + 1);
    }
    if (depth < 3 && ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      // A same-file helper that builds the refs: `assertRefsInScope(s, invoiceRefs(input))`.
      const fn = topLevel(sf, n.expression.text);
      if (fn && isFunction(fn) && namesIn(fn, field, sf, depth + 1)) return true;
    }
    return false;
  });
}

// ── Checks ──

/** Keys that tie a lookup to the caller's tenant: the org, or a project already gated to it. */
const SCOPE_KEYS = new Set(["orgId", "projectId"]);

/** Whether an object holds one of these keys: written in it, or in a scope object spread into it. */
function hasKey(obj: ts.Node, keys: Set<string>): boolean {
  return some(obj, (k) => {
    if (ts.isPropertyAssignment(k)) return keys.has(keyName(k.name) ?? "");
    if (ts.isShorthandPropertyAssignment(k)) return keys.has(k.name.text);
    if (ts.isSpreadAssignment(k) && ts.isIdentifier(k.expression)) {
      const init = localInit(k.expression);
      return !!init && ts.isObjectLiteralExpression(init) && hasKey(init, keys);
    }
    return false;
  });
}

const whereOf = (call: ts.CallExpression) => {
  const arg = call.arguments[0];
  const w = arg && ts.isObjectLiteralExpression(arg)
    ? arg.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && keyName(p.name) === "where")
    : undefined;
  return w?.initializer;
};

const isOrgMemberCall = (n: ts.CallExpression) =>
  ts.isPropertyAccessExpression(n.expression) &&
  ts.isPropertyAccessExpression(n.expression.expression) &&
  n.expression.expression.name.text === "orgMember";

/** The calls and lookups in a module that can check a field, gathered once per module. */
interface Checks {
  calls: ts.CallExpression[];
  /** `where: { id: …, orgId }`: the `id` value, for lookups scoped to the tenant. */
  scopedIds: ts.Expression[];
  /** `orgMember.*({ where: { orgId, … } })`: the where, for lookups of members. */
  memberWheres: ts.Expression[];
}
const checksCache = new WeakMap<ts.SourceFile, Checks>();

function checksIn(sf: ts.SourceFile): Checks {
  const cached = checksCache.get(sf);
  if (cached) return cached;
  const out: Checks = { calls: [], scopedIds: [], memberWheres: [] };
  const deps = new Set([...Object.keys(REFS_ARG), ...NAMED, ...Object.values(DEDICATED).flat()]);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      if (deps.has(calleeName(n) ?? "")) out.calls.push(n);
      const where = isOrgMemberCall(n) ? whereOf(n) : undefined;
      if (where && ts.isObjectLiteralExpression(where) && hasKey(where, new Set(["orgId"]))) out.memberWheres.push(where);
    }
    if (ts.isPropertyAssignment(n) && keyName(n.name) === "where" && ts.isObjectLiteralExpression(n.initializer)) {
      const id = n.initializer.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && keyName(p.name) === "id");
      if (id && hasKey(n.initializer, SCOPE_KEYS)) out.scopedIds.push(id.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  checksCache.set(sf, out);
  return out;
}

/** The modules whose checks count for a file: itself, and VIA's for the services it calls, and theirs. */
function checkingModules(sf: ts.SourceFile, srcs: Sources): ts.SourceFile[] {
  const out = [sf];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const via = own(VIA, calleeName(n) ?? "");
      const mod = via ? srcs.get(via) : null;
      if (mod && !out.includes(mod)) out.push(mod);
    }
    ts.forEachChild(n, visit);
  };
  for (let i = 0; i < out.length; i++) visit(out[i]);
  return out;
}

function checkedIn(mods: ts.SourceFile[], field: string): boolean {
  const dedicated = own(DEDICATED, field) ?? [];
  return mods.some((sf) => {
    const c = checksIn(sf);
    return (
      c.scopedIds.some((id) => namesIn(id, field, sf)) ||
      c.memberWheres.some((w) => namesIn(w, field, sf)) ||
      c.calls.some((call) => {
        const name = calleeName(call) ?? "";
        const refsAt = own(REFS_ARG, name);
        if (refsAt !== undefined) return !!call.arguments[refsAt] && namesIn(call.arguments[refsAt], field, sf);
        if (NAMED.has(name)) return call.arguments.some((a) => namesIn(a, field, sf));
        return dedicated.includes(name);
      })
    );
  });
}

// ── The scan ──

/** `searchParams.get("parentId")` in a write handler: a reference from the query string. */
function queryFields(root: ts.Node, out: Set<string>): void {
  const isSearchParams = (e: ts.Expression): boolean => {
    if (/searchParams$/.test(squash(e))) return true;
    const init = ts.isIdentifier(e) ? localInit(e) : undefined;
    return !!init && /searchParams$/.test(squash(init));
  };
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "get" &&
      isSearchParams(n.expression.expression) &&
      n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && REF_KEY.test(n.arguments[0].text)
    ) {
      out.add(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
}

const isExported = (n: ts.Node) =>
  ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const isRoute = (file: string) => /\/route\.tsx?$/.test(file);

/** A route's write handlers; every exported function of a tool module. */
function entryPoints(sf: ts.SourceFile, file: string): ts.Node[] {
  const wanted = (name: string) => (isRoute(file) ? WRITE_METHODS.has(name) : true);
  const out: ts.Node[] = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && isExported(st) && wanted(st.name.text)) out.push(st);
    if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && wanted(d.name.text) && init && (isFunction(init) || ts.isCallExpression(init))) out.push(init);
      }
    }
  }
  return out;
}

export interface BodyRef {
  file: string;
  field: string;
  checked: boolean;
}

/** Every (file, field) a write accepts, and whether a recognised check names it. */
export function bodyRefs(files: string[], read: Read = disk): BodyRef[] {
  const srcs = new Sources(read);
  const out: BodyRef[] = [];
  for (const file of files) {
    const sf = srcs.get(file);
    if (!sf) continue;
    const fields = new Set<string>();
    const seen = new Set<string>();
    for (const entry of entryPoints(sf, file)) {
      collectFields(entry, file, srcs, seen, fields);
      if (isRoute(file)) queryFields(entry, fields);
    }
    if (fields.size === 0) continue;
    const mods = checkingModules(sf, srcs);
    for (const field of [...fields].sort()) out.push({ file, field, checked: checkedIn(mods, field) });
  }
  return out;
}

const listed = (rec: Record<string, Record<string, string>>, r: { file: string; field: string }) =>
  !!own(own(rec, r.file) ?? {}, r.field);

/** The pairs neither checked by a recognised check nor listed with a reason. */
export function uncheckedRefs(refs: BodyRef[]): string[] {
  return refs
    .filter((r) => !r.checked && !listed(INLINE, r) && !listed(KNOWN_GAPS, r))
    .map((r) => `${r.file} ${r.field}`);
}

function scanned(): string[] {
  return [...globSync("src/app/api/**/route.ts"), ...globSync(`${EXE}*.ts`).filter((f) => !f.endsWith(".test.ts"))]
    .map((f) => f.split("\\").join("/"))
    .sort();
}

let real: BodyRef[] | undefined;
const realRefs = () => (real ??= bodyRefs(scanned()));

describe("every field that names a row is checked against the caller's org", () => {
  it("scans a real surface (not vacuous)", () => {
    const refs = realRefs().map((r) => `${r.file} ${r.field}`);
    expect(scanned().length).toBeGreaterThan(300);
    expect(refs.length).toBeGreaterThan(200);
    // A field from each place a schema can live: the route itself, its
    // contract, a shared lib/openapi schema, a tool; and a person.
    expect(refs).toEqual(expect.arrayContaining([
      `${API}bills/route.ts partnerId`,
      `${API}time-entries/route.ts clinId`,
      `${API}projects/[projectId]/work-items/route.ts parentId`,
      `${API}projects/[projectId]/intervals/[intervalId]/complete/route.ts moveIncompleteToIntervalId`,
      `${API}time-off/route.ts userId`,
      `${EXE}meetings.ts sprintId`,
    ]));
  }, 120_000);

  it("each is checked, or listed in INLINE with how, or in KNOWN_GAPS", () => {
    // A new entry here is a field that names another row and is written
    // unchecked. Check it with assertRefsInScope (lib/rbac/foreign-refs.ts);
    // list it in INLINE only if it is checked another way, and say how.
    expect(uncheckedRefs(realRefs())).toEqual([]);
  }, 120_000);

  it("INLINE and KNOWN_GAPS list only pairs the scan still finds unchecked (no stale entries)", () => {
    const unchecked = new Set(realRefs().filter((r) => !r.checked).map((r) => `${r.file} ${r.field}`));
    const pairs = [INLINE, KNOWN_GAPS].flatMap((rec) =>
      Object.entries(rec).flatMap(([file, fields]) => Object.keys(fields).map((f) => `${file} ${f}`)));
    expect(pairs.filter((pair) => !unchecked.has(pair))).toEqual([]);
  }, 120_000);

  it("VIA names functions that exist in the modules named", () => {
    const srcs = new Sources(disk);
    expect(Object.entries(VIA).filter(([fn, file]) => !srcs.get(file) || !topLevel(srcs.get(file)!, fn))).toEqual([]);
  });
});

// ─── The scanner against routes written to slip past it ─────────────────────

const PLANT = `${API}zz-plant`;
const head = `import { z } from "zod";\nimport { prisma } from "@/lib/db/client";\n`;
const post = (body: string) => `export async function POST(req: Request) { const b = s.parse(await req.json()); ${body} }`;
const label = `await prisma.workItemLabel.createMany({ data: b.labelIds.map((labelId) => ({ workItemId: "x", labelId })) });`;

/** Each plant, and the fields it must be reported for. */
const PLANTS: Record<string, { src: string; unchecked: string[] }> = {
  "a-unchecked-list": {
    src: `${head}const s = z.object({ labelIds: z.array(z.string().uuid()) });\n${post(label)}`,
    unchecked: ["labelIds"],
  },
  "b-one-field-checked-not-the-other": {
    src: `${head}import { assertRefsInScope } from "@/lib/rbac/foreign-refs";\n` +
      `const s = z.object({ partnerId: z.string().uuid(), labelIds: z.array(z.string().uuid()) });\n` +
      post(`await assertRefsInScope({ orgId: "o" }, { partner: b.partnerId }); ${label}`),
    unchecked: ["labelIds"],
  },
  "c-schema-constant": {
    src: `${head}const UuidList = z.array(z.string().uuid());\nconst s = z.object({ labelIds: UuidList, labels: UuidList });\n${post(label)}`,
    unchecked: ["labelIds", "labels"],
  },
  "d-snake-case": {
    src: `${head}const s = z.object({ label_ids: z.array(z.string().uuid()), parent_id: z.string().uuid() });\n` +
      post(`await prisma.workItem.update({ where: { id: "x" }, data: { parentId: b.parent_id } });`),
    unchecked: ["label_ids", "parent_id"],
  },
  "e-quoted-keys": {
    src: `${head}const s = z.object({ "labelIds": z.array(z.string().uuid()), "parentId": z.string().uuid() });\n` +
      post(`await prisma.workItem.update({ where: { id: "x" }, data: { parentId: b.parentId } });`),
    unchecked: ["labelIds", "parentId"],
  },
  "f-any-ids-name-and-uuid-values": {
    src: `${head}const s = z.object({ dependsOn: z.array(z.string().uuid()), assigneeIds: z.array(z.string().uuid()), watcherIds: z.array(z.string().uuid()) });\n` +
      post(`await prisma.workItemLink.createMany({ data: b.dependsOn.map((t) => ({ sourceItemId: "x", targetItemId: t })) });`),
    unchecked: ["assigneeIds", "dependsOn", "watcherIds"],
  },
  "g-nested-connect-and-set": {
    src: `${head}const s = z.object({ parent: z.object({ connect: z.object({ id: z.string().uuid() }) }), labels: z.object({ set: z.array(z.object({ id: z.string() })) }) });\n` +
      post(`await prisma.workItem.update({ where: { id: "x" }, data: { parent: b.parent } as never });`),
    unchecked: ["labels", "parent"],
  },
  // NOT reported, by design: an opaque JSON record has no key that names a
  // row, so there is no field to check. What it holds is the reader's to
  // validate (a board's config is rendered, never joined on).
  "h-opaque-record": {
    src: `${head}const s = z.object({ config: z.record(z.string(), z.unknown()) });\n` +
      post(`await prisma.board.update({ where: { id: "x" }, data: { config: b.config as never } });`),
    unchecked: [],
  },
  "i-query-string": {
    src: `import { prisma } from "@/lib/db/client";\nexport async function POST(req: Request) { const parentId = new URL(req.url).searchParams.get("parentId"); await prisma.workItem.update({ where: { id: "x" }, data: { parentId } }); }`,
    unchecked: ["parentId"],
  },
  "j-imported-schema": {
    src: `import { prisma } from "@/lib/db/client";\nimport { PlantBody } from "@/lib/zz-plant-schema";\n` +
      `export async function POST(req: Request) { const b = PlantBody.parse(await req.json()); await prisma.workItem.update({ where: { id: "x" }, data: { parentId: b.parentId } }); }`,
    unchecked: ["labelIds", "parentId"],
  },
  "k-path-param-checked-body-field-not": {
    src: `${head}import { requireProjectVisible } from "@/lib/rbac/require-project-read";\nconst s = z.object({ projectId: z.string().uuid() });\n` +
      `export async function POST(req: Request, { params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; await requireProjectVisible({} as never, projectId); const b = s.parse(await req.json()); await prisma.workItem.update({ where: { id: "x" }, data: { projectId: b.projectId } }); }`,
    unchecked: ["projectId"],
  },
  "l-scope-argument-is-not-a-check": {
    src: `${head}import { assertRefsInScope } from "@/lib/rbac/foreign-refs";\nconst s = z.object({ projectId: z.string().uuid(), parentId: z.string().uuid() });\n` +
      post(`await assertRefsInScope({ orgId: "o", projectId: b.projectId }, { workItem: b.parentId });`),
    unchecked: ["projectId"],
  },
  "m-words-in-comments-and-strings": {
    src: `${head}// labelIds: z.array(z.string().uuid())\nconst s = z.object({ title: z.string() });\n` +
      post(`const note = "parentId: z.string().uuid()"; await prisma.workItem.update({ where: { id: "x" }, data: { title: b.title + note } });`),
    unchecked: [],
  },
  "r-a-check-of-rows-read-back-is-not-a-check-of-the-field": {
    src: `${head}const s = z.object({ ids: z.array(z.string().uuid()) });\n` +
      post(`const rows = await prisma.workItem.findMany({ where: { id: { in: b.ids } } }); const owners = rows.map((r) => r.createdById); ` +
        `await prisma.orgMember.count({ where: { orgId: "o", userId: { in: owners } } });`),
    unchecked: ["ids"],
  },
  // The controls: the same shapes, checked, are not reported.
  "n-checked-by-the-helper": {
    src: `${head}import { assertRefsInScope } from "@/lib/rbac/foreign-refs";\nconst s = z.object({ labelIds: z.array(z.string().uuid()), parent_id: z.string().uuid() });\n` +
      post(`const ids = [...new Set(b.labelIds)]; await assertRefsInScope({ orgId: "o" }, { label: ids, workItem: b["parent_id"] }); ${label}`),
    unchecked: [],
  },
  "o-checked-by-a-scoped-lookup-and-a-member-lookup": {
    src: `${head}const s = z.object({ partnerId: z.string().uuid(), ownerId: z.string().uuid() });\n` +
      post(`const orgId = "o"; if (!(await prisma.partner.findFirst({ where: { id: b.partnerId, orgId } }))) return; ` +
        `if (!(await prisma.orgMember.count({ where: { orgId, userId: b.ownerId } }))) return;`),
    unchecked: [],
  },
  "q-checked-in-batches": {
    src: `${head}const s = z.object({ ids: z.array(z.string().uuid()) });\n` +
      post(`for (const batch of chunk(b.ids, 100)) await prisma.workItem.findMany({ where: { id: { in: batch }, orgId: "o" } });`),
    unchecked: [],
  },
  "p-body-project-checked": {
    src: `${head}import { requireProjectVisible } from "@/lib/rbac/require-project-read";\nconst s = z.object({ projectId: z.string().uuid() });\n` +
      post(`await requireProjectVisible({} as never, b.projectId);`),
    unchecked: [],
  },
};

const PLANT_SCHEMA = `import { z } from "zod";\nexport const PlantBody = z.object({ parentId: z.string().uuid(), labelIds: z.array(z.string().uuid()) });\n`;

describe("the scanner reports the routes written to slip past it", () => {
  const files = Object.fromEntries(Object.entries(PLANTS).map(([name, p]) => [`${PLANT}-${name}/route.ts`, p.src]));
  const read: Read = (p) => (p === "src/lib/zz-plant-schema.ts" ? PLANT_SCHEMA : files[p] ?? disk(p));
  const refs = () => bodyRefs(Object.keys(files), read);

  it.each(Object.entries(PLANTS))("%s", (name, plant) => {
    const file = `${PLANT}-${name}/route.ts`;
    expect(uncheckedRefs(refs().filter((r) => r.file === file)).map((pair) => pair.slice(file.length + 1))).toEqual(plant.unchecked);
  });
});
