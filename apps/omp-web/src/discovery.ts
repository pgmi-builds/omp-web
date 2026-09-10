/**
 * OMP skills + slash-command discovery, bridged into the host's capability
 * seams (`ctx.skills` + `ctx.commands`). Both services stay mounted by
 * dsh-base/dsh-web-app; the bridge only supplies data/registrations — the
 * UI (SkillRow, the composer `/` menu) already reads them.
 *
 * @module omp-web/discovery
 */
import type { Context } from "@deepseek-ai/cordis";
import { readFile } from "node:fs/promises";
import { listSkills, listSlashCommands } from "./sdk-client.js";

// Local slices of the host services (the full types live in dsh-skill /
// dsh-commands, which this package does not vendor).
interface SkillRegistrySlice {
  registerProvider(create: (control: unknown) => unknown): () => void;
}
interface CommandRuntimeSlice {
  register(definition: {
    name: string;
    description: string;
    input?: { hint?: string; attachments?: boolean };
    handler(): { kind: "success"; text?: string } | { kind: "error"; text: string };
  }): () => void;
}

/** Strip a slash-command name to the host's `/^[a-z][a-z0-9_-]*$/` shape. */
function sanitizeCommandName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").slice(0, 64);
  return cleaned === "" ? "omp-command" : cleaned;
}

/**
 * Mount OMP discovery on the host seams. Fail-open: a missing `skills` or
 * `commands` service leaves the feature dormant, never blocks host boot.
 *
 * @param ctx - host plugin context.
 */
export function installOmpDiscovery(ctx: Context): void {
  // Skills: a discovery provider whose `list(cwd)` scans OMP's store for the
  // caller's workspace; the body is read lazily from SKILL.md in `get`.
  ctx.inject(["skills"], (scoped) => {
    const skills = scoped.get("skills") as SkillRegistrySlice | undefined;
    if (skills === undefined) return;
    skills.registerProvider(() => ({
      name: "omp",
      list: async (options: { cwd?: string }) => {
        const found = await listSkills(options.cwd);
        return found.map((skill, rank) => ({
          name: skill.name,
          description: skill.description,
          rank,
          locator: skill.filePath,
          path: skill.filePath,
          invocation: { modelInvocable: true, userInvocable: true },
          source: "custom",
          provider: "omp",
        }));
      },
      get: async (candidate: { name: string; description: string; locator: unknown }) => {
        const content = await readFile(String(candidate.locator), "utf8").catch(() => "");
        return {
          name: candidate.name,
          description: candidate.description,
          content,
          invocation: { modelInvocable: true, userInvocable: true },
          source: "custom",
          provider: "omp",
        };
      },
    }));
  });

  // Slash commands: register OMP's commands once at boot (default-workspace
  // discovery). The handler echoes the command body as the result text — a
  // first-pass surface; a deeper integration would route execution through the
  // bridged Agent.
  ctx.inject(["commands"], (scoped) => {
    const commands = scoped.get("commands") as CommandRuntimeSlice | undefined;
    if (commands === undefined) return;
    void listSlashCommands().then((found) => {
      for (const command of found) {
        commands.register({
          name: sanitizeCommandName(command.name),
          description: command.description,
          handler: () => ({ kind: "success", text: command.content }),
        });
      }
    });
  });
}
