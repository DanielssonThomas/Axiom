import { posix as path } from "node:path";
import ts from "typescript";
import { inspectComposition } from "../ui-atomic/checks.js";
import type { CompositionComponent } from "../ui-atomic/checks.js";

type Project = { name: string; sourceRoot: string } & (
  | { kind: "application"; shellFiles: readonly string[] }
  | { kind: "library"; publicApi: string }
);

export interface AngularWorkspace {
  /** Workspace-relative POSIX paths from the inspected source revision. */
  files: Readonly<Record<string, string>>;
  projects: readonly Project[];
  paths: ts.CompilerOptions["paths"];
  /** Name and intended scope of inspected domain, input/output, and view-model contracts. */
  models: readonly {
    name: string;
    project: string;
    scope: string;
    visibility: "owner" | "public";
  }[];
}

interface StructureIssue {
  code: string;
  path: string;
  dependency?: string | string[];
  model?: string;
}

const layerByDirectory = {
  atoms: "atom",
  molecules: "molecule",
  organisms: "organism",
  templates: "template",
} satisfies Record<string, CompositionComponent["level"]>;

function within(file: string, root: string) {
  return file === root || file.startsWith(root + "/");
}

function createProgram({ files, paths }: AngularWorkspace) {
  const options: ts.CompilerOptions = {
    noLib: true,
    types: [],
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    ...(paths && { paths }),
  };
  const virtualFiles = new Map(Object.entries(files).map(([file, text]) => [path.resolve("/", file), text]));
  const directories = new Set<string>(["/"]);
  for (const file of virtualFiles.keys()) {
    for (let directory = path.dirname(file); !directories.has(directory); directory = path.dirname(directory)) {
      directories.add(directory);
    }
  }
  const host: ts.CompilerHost = {
    ...ts.createCompilerHost(options),
    directoryExists: (directory) => directories.has(directory),
    fileExists: (file) => virtualFiles.has(file),
    readFile: (file) => virtualFiles.get(file),
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (file) => file,
    useCaseSensitiveFileNames: () => true,
    getSourceFile(file, languageVersion) {
      const text = virtualFiles.get(file);
      return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true);
    },
  };
  const program = ts.createProgram([...virtualFiles.keys()].filter((file) => file.endsWith(".ts")), options, host);
  return { program, host, options };
}

function componentIn(source: ts.SourceFile) {
  const coreAliases = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@angular/core") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) coreAliases.add(bindings.name.text + ".Component");
    if (bindings && ts.isNamedImports(bindings)) {
      for (const imported of bindings.elements) {
        if ((imported.propertyName ?? imported.name).text === "Component") coreAliases.add(imported.name.text);
      }
    }
  }
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    for (const decorator of ts.getDecorators(statement) ?? []) {
      if (!ts.isCallExpression(decorator.expression)) continue;
      const { expression, arguments: [metadata] } = decorator.expression;
      if (coreAliases.has(expression.getText(source)) && metadata && ts.isObjectLiteralExpression(metadata)) {
        return { name: statement.name.text, metadata };
      }
    }
  }
}

function strings(node: ts.Expression | undefined): string[] {
  if (!node) return [];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(strings);
  return [];
}

function componentFileIssues(
  file: string,
  component: NonNullable<ReturnType<typeof componentIn>>,
  workspace: AngularWorkspace,
): StructureIssue[] {
  const directory = path.dirname(file);
  const segments = directory.split("/");
  const issues: StructureIssue[] = [];
  if (segments.some((segment) => segment === "pages" || segment === "collections")) {
    const stem = path.basename(file, ".component.ts");
    if (!file.endsWith(".component.ts") || path.basename(directory) !== stem) {
      issues.push({ code: "component-directory", path: file });
    }
    const externalFiles = new Map<string, string[]>();
    for (const property of component.metadata.properties) {
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        externalFiles.set(property.name.text, strings(property.initializer));
      }
    }
    const template = externalFiles.get("templateUrl")?.[0];
    const expected = file.replace(/\.ts$/, ".html");
    if (!template || path.resolve("/", directory, template) !== "/" + expected || !Object.hasOwn(workspace.files, expected)) {
      issues.push({ code: "split-component", path: file, dependency: template ?? expected });
    }
    for (const style of [...externalFiles.get("styleUrl") ?? [], ...externalFiles.get("styleUrls") ?? []]) {
      const target = path.resolve("/", directory, style).slice(1);
      if (path.dirname(target) !== directory || !Object.hasOwn(workspace.files, target)) {
        issues.push({ code: "split-component", path: file, dependency: target });
      }
    }
    const specName = path.basename(file, ".ts") + ".spec.ts";
    for (const candidate of Object.keys(workspace.files)) {
      if (path.basename(candidate) === specName && path.dirname(candidate) !== directory
        && !Object.hasOwn(workspace.files, candidate.replace(/\.spec\.ts$/, ".ts"))) {
        issues.push({ code: "split-component", path: file, dependency: candidate });
      }
    }
  }
  const layer = getLayer(file);
  if (layer && (!file.endsWith(`-${layer}.component.ts`)
    || !component.name.endsWith(layer[0]!.toUpperCase() + layer.slice(1) + "Component"))) {
    issues.push({ code: "atomic-suffix", path: file });
  }
  return issues;
}

function getLayer(file: string) {
  for (const directory of path.dirname(file).split("/").reverse()) {
    if (Object.hasOwn(layerByDirectory, directory)) return layerByDirectory[directory as keyof typeof layerByDirectory];
  }
}

function getDependencies(source: ts.SourceFile, { host, options }: ReturnType<typeof createProgram>) {
  const dependencies = new Set<string>();
  function inspect(node: ts.Node) {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const resolved = ts.resolveModuleName(specifier.text, source.fileName, options, host).resolvedModule;
      if (resolved) dependencies.add(resolved.resolvedFileName.slice(1));
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
  return dependencies;
}

function exportDeclarations(source: ts.SourceFile | undefined, checker: ts.TypeChecker) {
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) return new Set<ts.Declaration>();
  return new Set(checker.getExportsOfModule(module).flatMap((entry) =>
    ((entry.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(entry) : entry).declarations ?? [])
  ));
}

function modelIssues(
  workspace: AngularWorkspace,
  sources: readonly ts.SourceFile[],
  program: ts.Program,
): StructureIssue[] {
  const issues: StructureIssue[] = [];
  const checker = program.getTypeChecker();
  for (const model of workspace.models) {
    const project = workspace.projects.find(({ name }) => name === model.project);
    if (!project || project.kind !== "library" || !within(model.scope, project.sourceRoot)) {
      issues.push({ code: "model-owner", path: model.scope, model: model.name });
      continue;
    }
    const declarations = sources.filter((source) => within(source.fileName.slice(1), project.sourceRoot))
      .flatMap((source) => source.statements.filter((node): node is ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.ClassDeclaration =>
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node))
          && node.name?.text === model.name
      ));
    if (declarations.length > 1) for (const declaration of declarations) {
      issues.push({ code: "duplicate-model", path: declaration.getSourceFile().fileName.slice(1), model: model.name });
    }
    if (!declarations.length) issues.push({ code: "missing-model", path: model.scope, model: model.name });
    const publicExports = exportDeclarations(program.getSourceFile("/" + project.publicApi), checker);
    for (const declaration of declarations) {
      const source = declaration.getSourceFile();
      const file = source.fileName.slice(1);
      if (!within(file, model.scope) || !/\.(model|schema)\.ts$/.test(file) || !exportDeclarations(source, checker).has(declaration)) {
        issues.push({ code: "model-owner", path: file, model: model.name });
      }
      if (publicExports.has(declaration) !== (model.visibility === "public")) {
        const code = model.visibility === "owner" ? "private-model-export" : "missing-model-export";
        issues.push({ code, path: project.publicApi, model: model.name });
      }
    }
  }
  return issues;
}

export function inspectAngularWorkspace(workspace: AngularWorkspace): StructureIssue[] {
  const issues: StructureIssue[] = [];
  const compiler = createProgram(workspace);
  const sources = compiler.program.getSourceFiles();
  const ownerOf = (file: string) => workspace.projects.find(({ sourceRoot }) => within(file, sourceRoot));
  const components: CompositionComponent[] = [];
  const atomicFiles = new Set(sources.filter((source) => getLayer(source.fileName.slice(1)) && componentIn(source))
    .map((source) => source.fileName.slice(1)));
  const publicExports = new Map(workspace.projects.flatMap((project) => project.kind === "library"
    ? [[project.name, exportDeclarations(compiler.program.getSourceFile("/" + project.publicApi), compiler.program.getTypeChecker())]]
    : []
  ));

  for (const project of workspace.projects) {
    if (workspace.projects.some((other) => other !== project && within(project.sourceRoot, other.sourceRoot))) {
      issues.push({ code: "overlapping-project", path: project.sourceRoot });
    }
    if (project.kind === "library" && (!within(project.publicApi, project.sourceRoot)
      || !Object.hasOwn(workspace.files, project.publicApi))) {
      issues.push({ code: "missing-library-api", path: project.publicApi });
    }
  }
  for (const source of sources) {
    const file = source.fileName.slice(1);
    const project = ownerOf(file);
    if (!project) {
      issues.push({ code: "unscoped-source", path: file });
      continue;
    }
    if (project.kind === "application" && !project.shellFiles.includes(file)) {
      issues.push({ code: "application-feature", path: file });
    }
    const dependencies = getDependencies(source, compiler);
    for (const dependency of dependencies) {
      const target = ownerOf(dependency);
      if (target?.kind === "library" && target !== project && dependency !== target.publicApi) {
        issues.push({ code: "private-library-import", path: file, dependency });
      }
    }
    const component = componentIn(source);
    if (!component) continue;
    issues.push(...componentFileIssues(file, component, workspace));
    const level = getLayer(file);
    if (!level) continue;
    const isPublic = [...publicExports.get(project.name) ?? []].some((node) =>
      node.getSourceFile() === source && ts.isClassDeclaration(node) && node.name?.text === component.name
    );
    const atomicDependencies = [...dependencies].filter((dependency) => atomicFiles.has(dependency));
    const checker = compiler.program.getTypeChecker();
    // Resolve the actual classes imported through a library barrel to preserve composition edges.
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !node.importClause) continue;
      const bindings = node.importClause.namedBindings;
      const aliases = [
        ...node.importClause.name ? [node.importClause.name] : [],
        ...bindings && ts.isNamedImports(bindings) ? bindings.elements.map((item) => item.name) : [],
      ];
      for (const alias of aliases) {
        const symbol = checker.getSymbolAtLocation(alias);
        if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) continue;
        for (const declaration of checker.getAliasedSymbol(symbol).declarations ?? []) {
          const target = declaration.getSourceFile().fileName.slice(1);
          if (atomicFiles.has(target) && !atomicDependencies.includes(target)) atomicDependencies.push(target);
        }
      }
    }
    components.push({ id: file, level, owner: project.name, visibility: isPublic ? "public" : "owner", dependencies: atomicDependencies });
  }
  for (const issue of inspectComposition(components)) {
    if (issue.code === "cycle") issues.push({ code: issue.code, path: issue.path[0]!, dependency: issue.path });
    else issues.push({ code: issue.code, path: issue.component, ...("dependency" in issue && { dependency: issue.dependency }) });
  }
  issues.push(...modelIssues(workspace, sources, compiler.program));
  return issues;
}
