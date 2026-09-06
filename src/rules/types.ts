export interface ProjectFact {
  kind: string;
  value: string;
  sourcePath: string;
}

export interface DeclaredCommand {
  name: string;
  executable: string;
  args: string[];
  sourcePath: string;
  provenance: 'declared';
  verified: false;
}

export interface ProjectScope {
  path: string;
  sources: string[];
  facts: ProjectFact[];
  commands: DeclaredCommand[];
  existingInstructions: string[];
}

export interface ProjectInstructionScope extends ProjectScope {
  selected: true;
  originalInstructions: string[];
  instructions: string[];
  hasUserOverride: boolean;
}

export interface ProjectInstructionOverride {
  scope: string;
  instructions: string[];
  provenance: 'user-override';
}

export interface ProjectInstructionModel {
  schemaVersion: 1;
  provenance: {
    generator: 'latchkit';
    basis: 'explicit-project-manifests';
    execution: 'not-run';
  };
  scopes: ProjectInstructionScope[];
}

export interface RuleExportWarning {
  code: string;
  providers: string[];
  scope?: string;
  reason: string;
}

export interface PlannedRuleExports {
  desiredFiles: Map<string, string>;
  desiredSections: Map<string, string>;
  warnings: RuleExportWarning[];
}
