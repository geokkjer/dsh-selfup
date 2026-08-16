/**
 * dsh-selfup — DeepSeek Harness self-update and deployment tools.
 *
 * This package is a profile bundle (`dsh.bundle.patch` → `cordis.patch.yml`)
 * mounting a host-side plugin that registers four model-visible tools with
 * zero runtime dependencies. Install it into a profile with
 * `dsh plugin --profile <name> add dsh-selfup` (or the git URL), then restart
 * the web server; the tools appear in every session.
 */

/** Stable Cordis plugin name. */
export const name: string

/** Hard dependencies: the tool registry and the bash execution seam. */
export const inject: readonly string[]

/** Apply the plugin: register `dsh_update_status`, `dsh_update`, `dsh_install`, `dsh_systemd`. */
export function apply(ctx: unknown): void
