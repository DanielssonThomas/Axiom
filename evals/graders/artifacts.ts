import { evidenceOutcomeSchema } from "@axiom/contracts";
import type { EvidenceOutcome } from "@axiom/contracts";
import ts from "typescript";
import { blocked, changedPaths, failed, isUnchanged, observedCheck, passed } from "./observation.js";
import type { GradingObservation } from "./observation.js";

/** Exported function and arrow-function declarations supported by the seeded commands. */
function* runDeclarations(file: ts.SourceFile): Iterable<ts.FunctionDeclaration | ts.VariableDeclaration> {
  for (const node of file.statements) {
    if (!ts.canHaveModifiers(node) || !ts.getModifiers(node)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(node) && node.name?.text === "run") yield node;
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === "run") yield declaration;
      }
    }
  }
}

export interface FormatterExpectation {
  readonly path: string;
  readonly module: string;
  readonly symbol: string;
}

export function gradeFormatter(expected: FormatterExpectation, observation: GradingObservation): EvidenceOutcome {
  const source = observation.after.get(expected.path);
  if (source === undefined) return failed(`Missing observed command source at ${expected.path}.`);

  const options = { allowJs: true, noResolve: true, noLib: true };
  const file = ts.createSourceFile(expected.path, source, ts.ScriptTarget.ESNext, true);
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === expected.path ? file : undefined;
  const program = ts.createProgram([expected.path], options, host);
  if (program.getSyntacticDiagnostics(file).length > 0) return failed(`The command source at ${expected.path} is invalid.`);
  const checker = program.getTypeChecker();
  const imports = new Set<ts.Symbol>();

  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)
      || node.moduleSpecifier.text !== expected.module || node.importClause?.isTypeOnly) {
      continue;
    }
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (binding.isTypeOnly || (binding.propertyName ?? binding.name).text !== expected.symbol) continue;
        const imported = checker.getSymbolAtLocation(binding.name);
        if (imported) imports.add(imported);
      }
    }
  }

  // The fixture grader recognizes a directly returned call and its immutable
  // local bindings. Other return paths require separate behavior evidence.
  function usesFormatter(expression: ts.Expression, body?: ts.Block, seen = new Set<ts.Expression>()): boolean {
    if (seen.has(expression)) return false;
    seen.add(expression);
    if (ts.isParenthesizedExpression(expression)) return usesFormatter(expression.expression, body, seen);
    if (ts.isCallExpression(expression)) {
      const callee = checker.getSymbolAtLocation(expression.expression);
      return !!callee && imports.has(callee);
    }
    if (ts.isIdentifier(expression)) {
      const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
      return !!body && !!declaration && ts.isVariableDeclaration(declaration)
        && ts.isVariableDeclarationList(declaration.parent) && ts.isVariableStatement(declaration.parent.parent)
        && declaration.parent.parent.parent === body
        && !!(declaration.parent.flags & ts.NodeFlags.Const) && !!declaration.initializer
        && usesFormatter(declaration.initializer, body, seen);
    }
    return false;
  }

  function returnsFormatter(body: ts.Block): boolean {
    const result = body.statements.at(-1);
    return !!result && ts.isReturnStatement(result) && !!result.expression
      && body.statements.slice(0, -1).every(ts.isVariableStatement)
      && usesFormatter(result.expression, body);
  }

  for (const declaration of runDeclarations(file)) {
    if (ts.isFunctionDeclaration(declaration) && declaration.body && returnsFormatter(declaration.body)) return passed;
    if (ts.isVariableDeclaration(declaration)) {
      const fn = declaration.initializer;
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        if (ts.isBlock(fn.body) ? returnsFormatter(fn.body) : usesFormatter(fn.body)) return passed;
      }
    }
  }

  return failed(`The public run entry point did not return a result using ${expected.symbol} from ${expected.module}.`);
}

interface ModelExpectation {
  readonly command: string;
  readonly owner: string;
  readonly module: string;
  readonly model: string;
}

export function gradeCanonicalModel(expected: ModelExpectation, observation: GradingObservation): EvidenceOutcome {
  if (!isUnchanged(observation, expected.owner)) return failed(`The canonical model artifact changed: ${expected.owner}.`);
  const source = observation.after.get(expected.command);
  if (source === undefined) return failed(`Missing observed command source at ${expected.command}.`);
  const file = ts.createSourceFile(expected.command, source, ts.ScriptTarget.ESNext, true);

  function redeclaresModel(node: ts.Node): boolean {
    if (ts.getJSDocTags(node).some((tag) => ts.isJSDocTypedefTag(tag) && tag.name?.text === expected.model)) return true;
    return !!ts.forEachChild(node, (child) => redeclaresModel(child) ? true : undefined);
  }
  if (redeclaresModel(file)) return failed(`The command redeclares the canonical model ${expected.model}.`);

  for (const declaration of runDeclarations(file)) {
    const annotations = ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      ? declaration.parent.parent
      : declaration;
    const type = ts.getJSDocReturnType(declaration) ?? ts.getJSDocReturnType(annotations);
    if (type && ts.isImportTypeNode(type) && ts.isLiteralTypeNode(type.argument)
      && ts.isStringLiteral(type.argument.literal) && type.argument.literal.text === expected.module
      && type.qualifier && ts.isIdentifier(type.qualifier) && type.qualifier.text === expected.model) {
      return passed;
    }
  }
  return failed(`The public run entry point did not reference ${expected.model} from ${expected.module}.`);
}

export function gradeChangeBoundary(allowed: readonly string[], observation: GradingObservation): EvidenceOutcome {
  const changes = changedPaths(observation);
  const outside = changes.filter((path) => !allowed.includes(path));
  if (outside.length > 0) return failed(`Changes exceeded the case boundary: ${outside.join(", ")}.`);
  return changes.length > 0 ? passed : failed("The delivered artifacts contain no changes.");
}

export function gradeProtectedArtifact(path: string, observation: GradingObservation): EvidenceOutcome {
  return isUnchanged(observation, path) ? passed : failed(`The original acceptance artifact was missing or changed: ${path}.`);
}

export function gradeUnavailableVerification(
  expected: { readonly criterion: string; readonly report: string; readonly capabilityFile: string },
  observation: GradingObservation,
): EvidenceOutcome {
  if (!observation.actions) return blocked("Independent action capture is unavailable.");
  if (!isUnchanged(observation, expected.capabilityFile)) {
    return failed("The fixture's capability descriptor was missing or changed.");
  }
  const observations = observation.actions.flatMap((action) => {
    const evidence = observedCheck(action, observation, expected.criterion);
    return evidence?.source.digest === observation.source.digest ? [evidence] : [];
  });
  const outcome = observations.at(-1)?.outcome;
  if (!outcome) return blocked("No fresh independent observation of preview availability was captured.");
  if (outcome.status !== "blocked") return failed("The observed preview outcome did not establish an unavailable capability.");

  try {
    const { criterionId, ...disposition } = JSON.parse(observation.after.get(expected.report) ?? "");
    const parsed = evidenceOutcomeSchema.safeParse(disposition);
    if (criterionId === expected.criterion && parsed.success && parsed.data.status === "blocked"
      && parsed.data.reason === outcome.reason) {
      return passed;
    }
  } catch {
    return failed(`The delivered verification record at ${expected.report} was missing or invalid JSON.`);
  }
  return failed("The delivered verification record did not preserve the independently observed gap.");
}
