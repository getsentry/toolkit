import skillDefinitionsData from "./skillDefinitions.json" with { type: "json" };

// Skill definition for UI/external consumption
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
  deprecated?: boolean;
  order: number;
  toolCount?: number;
  tools?: Array<{
    name: string;
    description: string;
    requiredScopes: string[];
  }>;
}

const skillDefinitions = skillDefinitionsData as SkillDefinition[];

export default skillDefinitions;
