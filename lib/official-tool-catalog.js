/** Pinned DSH 0.2.0-rc.2 tool catalog (docs/tool-catalog.md and source).
 * Names, not providers, are public host API: configurable aliases must be declared
 * explicitly. Unknown third-party tools are deliberately not classified by guesses.
 */
import { publicToolName } from './policy.js'

export const OFFICIAL_TOOL_NAMES = Object.freeze([
  'plugin_manager', 'list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource',
  'run_code', 'exit_plan_mode', 'plan', 'bash', 'pwsh', 'bash_persistent', 'pwsh_persistent',
  'present', 'cordis_inspect_list', 'cordis_inspect_query', 'str_replace_editor',
  'edit', 'read', 'read_image', 'write', 'glob', 'grep',
  'terminal_close', 'terminal_list', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal',
  'create_goal', 'get_goal', 'update_goal', 'schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update',
  'lsp', 'ralph', 'skill', 'session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace',
  'list_subagent_models', 'subagent', 'subagent_fork', 'interrupt_agent', 'list_agents', 'send_message',
  'job_kill', 'job_list', 'job_output', 'spawn_teammate', 'team_task_create', 'team_task_get',
  'team_task_list', 'team_task_update', 'wait_agent', 'todo_write', 'workflow',
  'load_workspace_dependencies', 'web_fetch', 'web_search', 'ask_user_question',
])
export const OFFICIAL_TOOL_PREFIXES = Object.freeze(['stagehand_', 'cua_driver_native__'])

// Only reviewed, implemented replacements belong here. A similarly named ops_*
// registration is NOT evidence of equivalent capability. In particular replace
// cannot stand in for write/edit, and background jobs cannot control host jobs.
export const OFFICIAL_REPLACEMENTS = Object.freeze({
  read: publicToolName('inspect_local_file'),
  glob: publicToolName('glob'),
  grep: publicToolName('grep'),
})

export function platformSurface(platform = process.platform) {
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error(`Unsupported official-tool hiding platform: ${platform}`)
  return { retainedCommand: platform === 'win32' ? 'pwsh' : 'bash', shellDefaultEnabled: true }
}

export function isOfficialTool(name, aliases = []) {
  return OFFICIAL_TOOL_NAMES.includes(name) || aliases.includes(name)
    || OFFICIAL_TOOL_PREFIXES.some(prefix => name.startsWith(prefix))
}
