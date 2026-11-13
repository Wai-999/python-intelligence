import { describe, expect, it } from "vitest";
import manifest from "./packages.json";
import { packageRules } from "./packages";

describe("lesson package rules", () => {
  const rules = packageRules({ _note: "x", _import_names: { "scikit-learn": "sklearn" }, numpy: "2.0.2", pandas: "2.2.3", "scikit-learn": "1.5.2" });

  it("only real package names are supported; metadata keys are not", () => {
    expect(Object.keys(rules.supported).sort()).toEqual(["numpy", "pandas", "scikit-learn"]);
    expect(rules.unsupported(["numpy", "_note", "_import_names", "scipy", "scipy"])).toEqual(["_note", "_import_names", "scipy"]);
  });

  it("maps a package to its import name only when they differ", () => {
    expect(rules.importNameOf("scikit-learn")).toBe("sklearn");
    expect(rules.importNameOf("numpy")).toBe("numpy");
    expect(rules.importNameOf("constructor")).toBe("constructor"); // no prototype lookups
  });

  it("a dependency Pyodide already loaded is not loaded again, but is still imported once", () => {
    // Loading pandas also loads numpy; a later numpy lesson needs no download, only its first import.
    const after = { pandas: "default channel", numpy: "default channel" };
    expect(rules.plan(["numpy"], after, new Set(["pandas"]))).toEqual({ toLoad: [], toImport: ["numpy"] });
    expect(rules.plan(["numpy", "numpy"], after, new Set(["pandas", "numpy"]))).toEqual({ toLoad: [], toImport: [] });
  });

  it("plans downloads by package name and imports by module name", () => {
    expect(rules.plan(["scikit-learn", "numpy"], {}, new Set())).toEqual({ toLoad: ["scikit-learn", "numpy"], toImport: ["sklearn", "numpy"] });
  });

  it("the shipped manifest is well formed", () => {
    const shipped = packageRules(manifest);
    expect(Object.keys(shipped.supported).sort()).toEqual(["numpy", "pandas", "sqlite3"]);
    expect((manifest as Record<string, unknown>)._cpython_modules).toEqual(["sqlite3"]);
    expect(shipped.importNameOf("sqlite3")).toBe("sqlite3");
    for (const [pkg, mod] of Object.entries((manifest as Record<string, unknown>)._import_names as Record<string, string>)) {
      expect(shipped.supported[pkg], `${pkg} in _import_names must be a supported package`).toBeDefined();
      expect(mod).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });
});
