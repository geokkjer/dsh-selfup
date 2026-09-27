/**
 * dsh-selfup — DeepSeek Harness self-update and deployment tools.
 *
 * This package is a profile bundle (`dsh.bundle.patch` → `cordis.patch.yml`)
 * mounting a host-side plugin that registers four model-visible tools with
 * zero runtime dependencies. Install it into a profile with
 * `dsh plugin --profile <name> add dsh-selfup` (or the git URL), then restart
 * the web server; the tools appear in every session.
 *
 * Every tool writes outside the session workspace (the checkout, the launcher,
 * the unit file), so each one gates on the resolved `ctx.sandboxPolicy` first:
 * a `workspace-write` root that does not cover the target produces a refusal
 * naming the blocked paths and the levers, instead of an opaque read-only
 * failure mid-step. The levers are the explicit `full_access: true` argument,
 * which widens that one call to `danger-full-access`, and the harness approval
 * channel (`ctx.approval`), which widens only on `allowed-once`.
 */

/** Stable Cordis plugin name. */
export const name: string

/** Hard dependencies: the tool registry and the bash execution seam. */
export const inject: readonly string[]

/** Apply the plugin: register `dsh_update_status`, `dsh_update`, `dsh_install`, `dsh_systemd`. */
export function apply(ctx: unknown): void
