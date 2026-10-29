// session-manager: agent-driven session naming.
// Регистрирует tool `name_session` (агент сам называет сессию; pi уже имеет встроенную /name).
// Конвенция имени — verb-led kebab-slug; проект НЕ входит в имя (берётся из cwd).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizeSlug } from "./normalize-slug.ts";
import { registerExplorer } from "./commands.ts";

const TOOL_DESCRIPTION = [
  "Set the current session display name as a verb-led kebab-slug",
  "(lowercase, hyphen-separated, e.g. 'fix-ss-render-stuck-arrow').",
  "Do NOT include the project name — it is derived from cwd automatically.",
  "Call once at the start of the first real task, and again at handoff/compaction",
  "only if the topic shifted.",
].join(" ");

export default function sessionManager(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "name_session",
    label: "Name session",
    description: TOOL_DESCRIPTION,
    parameters: Type.Object({
      name: Type.String({
        description: "Session name in verb-topic-slug form (e.g. 'fix-ss-render-stuck-arrow')",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const slug = normalizeSlug(String(params.name));
      if (!slug) {
        return {
          content: [{ type: "text", text: "name_session: name normalized to an empty slug; not set." }],
          details: { slug: "" },
        };
      }
      pi.setSessionName(slug);
      return {
        content: [{ type: "text", text: `Session named: ${slug}` }],
        details: { slug },
      };
    },
  });

  registerExplorer(pi);
}
