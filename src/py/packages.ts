// Lesson package rules shared by the worker (pure, so they are unit-tested without Pyodide).
// packages.json: keys starting with "_" are metadata; every other key is a package name with its pinned version.
// "_import_names" maps a package to the module learners import when the two differ (e.g. scikit-learn → sklearn).

export type PackageManifest = Record<string, unknown>;

export interface PackageRules {
  supported: Record<string, string>;
  importNameOf(pkg: string): string;
  unsupported(requested: string[]): string[];
  /** What a run still needs: packages Pyodide has not loaded (dependencies count), and modules not yet imported. */
  plan(requested: string[], loadedByPyodide: Record<string, string>, imported: ReadonlySet<string>): { toLoad: string[]; toImport: string[] };
}

export function packageRules(manifest: PackageManifest): PackageRules {
  const supported = Object.fromEntries(
    Object.entries(manifest).filter(([k, v]) => !k.startsWith("_") && typeof v === "string"),
  ) as Record<string, string>;
  const names = (manifest._import_names ?? {}) as Record<string, string>;
  const importNameOf = (pkg: string) => (Object.hasOwn(names, pkg) ? names[pkg]! : pkg);
  return {
    supported,
    importNameOf,
    unsupported: (requested) => [...new Set(requested)].filter((name) => !Object.hasOwn(supported, name)),
    plan(requested, loadedByPyodide, imported) {
      const unique = [...new Set(requested)];
      return {
        toLoad: unique.filter((name) => !Object.hasOwn(loadedByPyodide, name)),
        toImport: unique.map(importNameOf).filter((mod) => !imported.has(mod)),
      };
    },
  };
}
