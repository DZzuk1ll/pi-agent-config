/** @type {import("dependency-cruiser").IConfiguration} */
const config = {
  forbidden: [
    {
      name: "no-circular",
      comment: "Do not allow circular module dependencies.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      comment: "Every import must resolve.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-production-to-tests",
      comment: "Production extension code must not depend on tests.",
      severity: "error",
      from: {
        path: "^extensions/",
        pathNot: [
          "(^|/)(test|tests|__tests__)/",
          "\\.(spec|test)\\.[cm]?[jt]sx?$",
        ],
      },
      to: {
        path: [
          "^tests/",
          "(^|/)(test|tests|__tests__)/",
          "\\.(spec|test)\\.[cm]?[jt]sx?$",
        ],
      },
    },
    {
      name: "no-undeclared-packages",
      comment: "External packages must be declared in package.json.",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "no-production-dev-dependencies",
      comment: "Only tests, configuration, and Pi's runtime-provided SDK may use devDependencies.",
      severity: "error",
      from: {
        path: "^extensions/",
        pathNot: [
          "(^|/)(test|tests|__tests__)/",
          "\\.(spec|test)\\.[cm]?[jt]sx?$",
          "(^|/)(vite|vitest|jest|webpack|eslint|biome)\\.config\\.[cm]?[jt]s$",
        ],
      },
      to: {
        dependencyTypes: ["npm-dev"],
        pathNot: "^node_modules/@earendil-works/pi-(coding-agent|agent-core|ai|tui)(/|$)",
      },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: false,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
    doNotFollow: {
      path: "node_modules",
      dependencyTypes: [
        "npm",
        "npm-dev",
        "npm-optional",
        "npm-peer",
        "npm-bundled",
        "npm-no-pkg",
      ],
    },
  },
};

export default config;
