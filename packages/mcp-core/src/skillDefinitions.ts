import skillDefinitionsData from "./skillDefinitions.json";

// Skill definition for UI/external consumption
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
  deprecated?: boolean;
  hostedOnly?: boolean;
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
