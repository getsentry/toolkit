#!/usr/bin/env tsx
/**
 * Validation script for skills-to-scopes mapping
 *
 * This script verifies that:
 * 1. Each skill enables the expected set of tools
 * 2. The scopes calculated from skills match expected permissions
 * 3. No tools are left inaccessible by any skill combination
 * 4. The mapping is consistent with the design document
 */

import { SKILLS, getScopesForSkills, type Skill } from "../src/skills.js";
import type { Scope } from "../src/permissions.js";
import tools from "../src/tools/index.js";
import {
  isCatalogInfrastructureToolName,
  isWrapperToolName,
  WRAPPER_TOOL_NAMES,
} from "../src/tools/surfaces.js";

// Color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

interface ValidationResult {
  skill: Skill;
  enabledTools: string[];
  requiredScopes: Set<Scope>;
}

/**
 * Calculate which tools are enabled by a given skill
 */
function getToolsForSkill(skill: Skill): string[] {
  const enabledTools: string[] = [];

  for (const [toolName, tool] of Object.entries(tools)) {
    if (
      isWrapperToolName(toolName) ||
      isCatalogInfrastructureToolName(toolName)
    ) {
      continue;
    }
    if (tool.skills.includes(skill)) {
      enabledTools.push(toolName);
    }
  }

  return enabledTools.sort();
}

/**
 * Validate skills-to-tools-to-scopes mapping
 */
async function validateMapping(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  for (const skillId of Object.keys(SKILLS) as Skill[]) {
    const enabledTools = getToolsForSkill(skillId);
    const requiredScopes = await getScopesForSkills(new Set([skillId]));

    results.push({
      skill: skillId,
      enabledTools,
      requiredScopes,
    });
  }

  return results;
}

/**
 * Check for tools that are not accessible by any skill
 * Excludes tools that are intentionally wrapper/infrastructure tools or foundational
 */
function findOrphanedTools(): string[] {
  // Foundational tools that are always available (no skill requirement)
  const FOUNDATIONAL_TOOLS = ["find_organizations", "find_projects", "whoami"];

  const orphanedTools: string[] = [];

  for (const [toolName, tool] of Object.entries(tools)) {
    // Skip special surfaces that are intentionally outside skill capability reports
    if (
      isWrapperToolName(toolName) ||
      isCatalogInfrastructureToolName(toolName)
    ) {
      continue;
    }

    // Skip foundational tools (they intentionally have no required skills)
    if (FOUNDATIONAL_TOOLS.includes(toolName)) {
      continue;
    }

    // Check if tool has no skills (orphaned)
    if (tool.skills.length === 0) {
      orphanedTools.push(toolName);
    }
  }

  return orphanedTools;
}

/**
 * Display validation results
 */
function displayResults(results: ValidationResult[]): void {
  console.log(
    `${colors.bright}${colors.blue}Skills-to-Tools-to-Scopes Validation${colors.reset}\n`,
  );
  console.log("━".repeat(80));

  for (const result of results) {
    const skill = SKILLS[result.skill];
    const scopeList = [...result.requiredScopes].sort();

    console.log(
      `\n${colors.bright}${colors.cyan}Skill: ${skill.name}${colors.reset}`,
    );
    console.log(`  ID: ${result.skill}`);
    console.log(`  Default: ${skill.defaultEnabled ? "Yes" : "No"}`);
    console.log(
      `\n  ${colors.bright}Enabled Tools (${result.enabledTools.length}):${colors.reset}`,
    );

    if (result.enabledTools.length === 0) {
      console.log(`    ${colors.yellow}⚠️  No tools enabled${colors.reset}`);
    } else {
      for (const toolName of result.enabledTools) {
        console.log(`    - ${toolName}`);
      }
    }

    console.log(
      `\n  ${colors.bright}Required Scopes (${scopeList.length}):${colors.reset}`,
    );
    for (const scope of scopeList) {
      console.log(`    - ${scope}`);
    }
  }

  console.log(`\n${"━".repeat(80)}`);
}

/**
 * Display orphaned tools warning
 */
function displayOrphanedTools(orphanedTools: string[]): void {
  if (orphanedTools.length > 0) {
    console.log(
      `\n${colors.bright}${colors.yellow}⚠️  Warning: Orphaned Tools${colors.reset}`,
    );
    console.log("The following tools are not accessible by any skill:\n");
    for (const toolName of orphanedTools) {
      console.log(`  - ${toolName}`);
    }
    console.log("");
  }
}

/**
 * Display summary statistics
 */
function displaySummary(results: ValidationResult[]): void {
  // Special categories of tools
  const wrapperTools = [...WRAPPER_TOOL_NAMES];
  const FOUNDATIONAL_TOOLS = ["find_organizations", "find_projects", "whoami"];
  const specialSurfaceTools = Object.keys(tools).filter((toolName) =>
    isCatalogInfrastructureToolName(toolName),
  );

  const totalTools = Object.keys(tools).length;
  const toolsWithSkills = new Set<string>();

  for (const result of results) {
    for (const tool of result.enabledTools) {
      toolsWithSkills.add(tool);
    }
  }

  // Total accessible = union of all accessible tool categories
  const allAccessibleTools = new Set<string>([
    ...toolsWithSkills,
    ...FOUNDATIONAL_TOOLS,
    ...wrapperTools,
    ...specialSurfaceTools,
  ]);
  const totalAccessibleTools = allAccessibleTools.size;

  const defaultSkills = Object.values(SKILLS).filter(
    (s) => s.defaultEnabled,
  ).length;
  const optionalSkills = Object.values(SKILLS).filter(
    (s) => !s.defaultEnabled,
  ).length;

  console.log(`${colors.bright}Summary:${colors.reset}`);
  console.log(
    `  Total Skills: ${Object.keys(SKILLS).length} (${defaultSkills} default, ${optionalSkills} optional)`,
  );
  console.log(`  Total Tools: ${totalTools}`);
  console.log(`  Tools with Skills: ${toolsWithSkills.size}`);
  console.log(
    `  Foundational Tools: ${FOUNDATIONAL_TOOLS.length} (always available)`,
  );
  console.log(`  Wrapper Tools: ${wrapperTools.length}`);
  console.log(`  Orphaned Tools: ${totalTools - totalAccessibleTools}`);

  if (totalAccessibleTools === totalTools) {
    console.log(`\n  ${colors.green}✓ All tools are accessible${colors.reset}`);
  } else {
    console.log(
      `\n  ${colors.yellow}⚠️  ${totalTools - totalAccessibleTools} tool(s) are not accessible${colors.reset}`,
    );
  }
}

// Main execution
async function main(): Promise<void> {
  try {
    const results = await validateMapping();
    displayResults(results);

    const orphanedTools = findOrphanedTools();
    displayOrphanedTools(orphanedTools);

    displaySummary(results);

    console.log("");

    // Exit with error if there are orphaned tools
    if (orphanedTools.length > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(
      `${colors.yellow}Error during validation:${colors.reset}`,
      error,
    );
    process.exit(1);
  }
}

void main();
