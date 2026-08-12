import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, WORKSPACES } from "./helpers";
import { routeKey } from "./route-guard";
import type { DeclaredRoute } from "./route-manifest";

/**
 * Audit coverage guard (US-015).
 *
 * AC1 says "a config or permission change" — a criterion about a category, not
 * about the four call sites that happen to exist today. Nothing in the type
 * system makes a new mutating endpoint write an audit entry, and the failure is
 * silent: the endpoint works, the tests pass, and the compliance answer is
 * simply missing for that action forever, because you cannot backfill history
 * you never recorded.
 *
 * So the manifest has to name the audit actions each mutating route writes, and
 * this guard checks those names against the `recordAuditEntry` calls actually
 * present in the source. It runs statically — no database, no booting the app —
 * so it can fail a pull request in the lint-and-typecheck job.
 */

/** HTTP methods that change something and therefore owe an audit decision. */
export const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

export interface DiscoveredAuditAction {
  /** Null when the `action` argument could not be resolved statically. */
  action: string | null;
  /** Raw `action:` argument, for the failure message. */
  rawArgument: string;
  source: string;
}

export type AuditProblemKind =
  | "undecided"
  | "unjustified"
  | "unknown-action"
  | "unclaimed-action"
  | "unresolvable-action";

export interface AuditProblem {
  kind: AuditProblemKind;
  subject: string;
  detail: string;
}

function listSourceFiles(): string[] {
  const files: string[] = [];
  for (const workspace of WORKSPACES) {
    const dir = join(repoRoot, workspace.dir, "src");
    if (!existsSync(dir)) {
      continue;
    }
    for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        files.push(join(dir, entry));
      }
    }
  }
  return files;
}

/**
 * Extracts the argument list of a call starting at `open` (the index of its
 * opening parenthesis), respecting nesting so a nested object or call does not
 * end it early. Returns null on an unbalanced source.
 */
function readCallArguments(source: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  return null;
}

/**
 * Every audit action written anywhere in the workspace sources.
 *
 * A static scan, in the same spirit as the US-013 route guard: an action it
 * cannot read is reported rather than skipped, because an unreadable call is a
 * call the guard is not actually protecting.
 */
export function discoverAuditActions(): DiscoveredAuditAction[] {
  const found: DiscoveredAuditAction[] = [];

  for (const file of listSourceFiles()) {
    const source = readFileSync(file, "utf8");
    const relative = file.slice(repoRoot.length + 1).replace(/\\/g, "/");

    // The negative lookbehind skips the declaration in audit.ts itself; every
    // other occurrence is a call site.
    const call = /(?<!function\s)\brecordAuditEntry\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = call.exec(source)) !== null) {
      const args = readCallArguments(source, match.index + match[0].length - 1);
      if (args === null) {
        found.push({ action: null, rawArgument: "<unbalanced call>", source: relative });
        continue;
      }

      const property = args.match(/(?:^|[{,\s])action:\s*([^,\n]+)/);
      if (!property) {
        found.push({ action: null, rawArgument: "<no action property>", source: relative });
        continue;
      }

      const raw = property[1].trim();
      const literal = raw.match(/^["'`]([^"'`]*)["'`]$/);
      found.push({ action: literal ? literal[1] : null, rawArgument: raw, source: relative });
    }
  }

  return found;
}

/**
 * The guard, as a pure function so it can be exercised against synthetic input.
 * An empty array means every mutation has an audit decision on the record and
 * every audit action in the source is claimed by something.
 */
export function findAuditGuardProblems(
  declared: DeclaredRoute[],
  discovered: DiscoveredAuditAction[],
  nonRouteActions: { action: string; note: string }[]
): AuditProblem[] {
  const problems: AuditProblem[] = [];

  const writtenActions = new Set(
    discovered.map((entry) => entry.action).filter((action): action is string => action !== null)
  );

  for (const entry of discovered) {
    if (entry.action === null) {
      problems.push({
        kind: "unresolvable-action",
        subject: `${entry.source}: ${entry.rawArgument}`,
        detail:
          "recordAuditEntry() is called with an action the guard cannot read statically. Use a string literal so the action can be tracked."
      });
    }
  }

  const claimed = new Set<string>(nonRouteActions.map((entry) => entry.action));

  for (const route of declared) {
    const key = routeKey(route.method, route.path);

    if (!MUTATING_METHODS.includes(route.method)) {
      continue;
    }

    if (route.audits === undefined) {
      problems.push({
        kind: "undecided",
        subject: key,
        detail: `Mutating route with no audit decision. Add audits: ["..."] naming the entries it writes (US-015), or audits: [] with a noAuditReason.`
      });
      continue;
    }

    if (route.audits.length === 0) {
      if (!route.noAuditReason?.trim()) {
        problems.push({
          kind: "unjustified",
          subject: key,
          detail:
            "Mutating route declares no audit entries and gives no reason. Set noAuditReason explaining why this mutation is not worth recording."
        });
      }
      continue;
    }

    for (const action of route.audits) {
      claimed.add(action);
      if (!writtenActions.has(action)) {
        problems.push({
          kind: "unknown-action",
          subject: `${key} -> ${action}`,
          detail: `The manifest claims this route writes "${action}", but no recordAuditEntry() call in the source uses that action. The route is not auditing what it says it audits.`
        });
      }
    }
  }

  for (const action of [...writtenActions].sort()) {
    if (!claimed.has(action)) {
      problems.push({
        kind: "unclaimed-action",
        subject: action,
        detail: `This audit action is written in the source but no route declares it and NON_ROUTE_AUDIT_ACTIONS does not list it. Claim it on the route that triggers it, or record why nothing does.`
      });
    }
  }

  return problems;
}
