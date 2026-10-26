/**
 * Built-in coding tool definitions in OpenAI function calling format.
 * Injected into request.tools when builtinToolsEnabled = true.
 * Server merges these with MCP tools automatically.
 */

import { TODO_WRITE_DESCRIPTION } from '../agent/todos'

import { BROWSER_TOOL } from '../browser/toolDefinition'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, any>
      required: string[]
    }
  }
}

export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file with line numbers. Returns up to 2000 lines by default. Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to working directory'
          },
          offset: {
            type: 'integer',
            description: 'Start reading from this line number (1-based). Default: 1'
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of lines to return. Default: 2000'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates the file and parent directories if they don\'t exist, overwrites if they do.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to working directory'
          },
          content: {
            type: 'string',
            description: 'Content to write to the file'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file by finding and replacing text. The search_text must match exactly (including indentation). Use read_file first to see the current content. Set replace_all=true to replace ALL occurrences (useful for renaming variables/functions).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to working directory'
          },
          search_text: {
            type: 'string',
            description: 'Exact text to find in the file (must be unique unless replace_all=true)'
          },
          replacement_text: {
            type: 'string',
            description: 'Text to replace the search_text with'
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace ALL occurrences instead of just the first. Default: false'
          }
        },
        required: ['path', 'search_text', 'replacement_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories at a path. Shows file types and sizes.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path relative to working directory. Use "." for the root.'
          },
          recursive: {
            type: 'boolean',
            description: 'List recursively (default: false). Use sparingly on large trees.'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search file contents for a pattern using ripgrep. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Search pattern (supports regex)'
          },
          path: {
            type: 'string',
            description: 'Directory to search in, relative to working directory. Default: "."'
          },
          glob: {
            type: 'string',
            description: 'File glob filter (e.g., "*.ts", "src/**/*.py")'
          }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files by name pattern. Returns matching file paths. Useful for finding files when you don\'t know their exact location.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'File name pattern (glob syntax, e.g., "*.test.ts", "package.json", "**/*.py")'
          },
          path: {
            type: 'string',
            description: 'Directory to search in, relative to working directory. Default: "."'
          }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_info',
      description: 'Get metadata about a file or directory: size, type (file/directory/symlink), last modified time, permissions.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path relative to working directory'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a directory and any necessary parent directories.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path relative to working directory'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Move a file or folder to the Trash (the user can put it back from Finder). Only delete what the task needs.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path relative to working directory'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'restore_file',
      description: 'Undo a file change. Files you edit, overwrite or delete are copied aside first. Without arguments: list the saved copies. With path: put back the newest copy of that file. With id: put back that copy.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File to restore, relative to working directory'
          },
          id: {
            type: 'string',
            description: 'A copy id from the list'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: 'Move or rename a file or directory.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Source path relative to working directory'
          },
          destination: {
            type: 'string',
            description: 'Destination path relative to working directory'
          }
        },
        required: ['source', 'destination']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'copy_file',
      description: 'Copy a file to a new location.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Source file path relative to working directory'
          },
          destination: {
            type: 'string',
            description: 'Destination file path relative to working directory'
          }
        },
        required: ['source', 'destination']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command in the working directory. Has a 60 second timeout. Returns stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute (runs via /bin/sh)'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_applescript',
      description: 'Execute AppleScript on this Mac with /usr/bin/osascript and return its output. Use this for macOS app automation and system scripting.',
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'AppleScript source code to execute'
          }
        },
        required: ['script']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web using Brave Search. Returns titles, URLs, and descriptions of matching pages.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query'
          },
          count: {
            type: 'integer',
            description: 'Number of results (1-20, default: 5)'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a URL and return its content as text. HTML is automatically converted to readable text. Useful for reading documentation, API responses, or web pages.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Full URL to fetch (https://...)'
          },
          max_length: {
            type: 'integer',
            description: 'Maximum characters to return (default: 20000)'
          }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ddg_search',
      // Do not name a single backend here: this string is what the MODEL
      // is told the tool does, and the request is served by whichever
      // backend answers (DuckDuckGo first, Mojeek as fallback). At the
      // time of writing DuckDuckGo answers 202 with an anti-bot page, so
      // naming it told the model something false about its own tool.
      description: 'Search the web (free, no API key required). Returns titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query'
          },
          count: {
            type: 'integer',
            description: 'Number of results (1-10, default: 5)'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description: 'Apply a unified diff patch to a file. Useful for making multiple related edits at once. The patch should be in standard unified diff format (--- a/file, +++ b/file, @@ hunks).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to working directory'
          },
          patch: {
            type: 'string',
            description: 'Unified diff patch content (with @@ hunk headers, - for removed lines, + for added lines)'
          }
        },
        required: ['path', 'patch']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'batch_edit',
      description: 'Apply multiple find-and-replace edits to a file in a single call. More efficient than multiple edit_file calls. Each edit is applied sequentially.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to working directory'
          },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                search_text: { type: 'string', description: 'Exact text to find' },
                replacement_text: { type: 'string', description: 'Text to replace with' }
              },
              required: ['search_text', 'replacement_text']
            },
            description: 'Array of {search_text, replacement_text} edits to apply in order'
          }
        },
        required: ['path', 'edits']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description: 'Run diagnostics on a file or project: type checking (TypeScript), linting, or syntax validation. Returns errors and warnings with file locations.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File or directory path relative to working directory. Use "." for project root.'
          },
          tool: {
            type: 'string',
            description: 'Diagnostic tool to run: "auto" (detect from project), "tsc" (TypeScript), "eslint", "python" (py_compile). Default: "auto"'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'insert_text',
      description: 'Insert text at a specific line number in a file. The new text is inserted BEFORE the specified line. Use read_file first to see line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to working directory' },
          line: { type: 'integer', description: 'Line number to insert before (1-based). Use 0 to append at end of file.' },
          text: { type: 'string', description: 'Text to insert (can be multiple lines)' }
        },
        required: ['path', 'line', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_lines',
      description: 'Replace a range of lines in a file with new content. Use read_file first to see line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to working directory' },
          start_line: { type: 'integer', description: 'First line to replace (1-based, inclusive)' },
          end_line: { type: 'integer', description: 'Last line to replace (1-based, inclusive)' },
          text: { type: 'string', description: 'Replacement text (can be more or fewer lines than the replaced range)' }
        },
        required: ['path', 'start_line', 'end_line', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_tree',
      description: 'Get a project directory tree respecting .gitignore rules. Shows the hierarchical file and directory structure.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to working directory. Default: "."' },
          max_depth: { type: 'integer', description: 'Maximum depth to traverse. Default: 4' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'apply_regex',
      description: 'Apply a regex find-and-replace across one or more files. Returns the number of replacements made per file.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regex pattern to search for' },
          replacement: { type: 'string', description: 'Replacement string (supports $1, $2 capture group references)' },
          path: { type: 'string', description: 'File or directory path relative to working directory' },
          glob: { type: 'string', description: 'File glob filter when path is a directory (e.g., "*.ts", "*.py")' }
        },
        required: ['pattern', 'replacement', 'path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_image',
      description: 'Read an image file and return its base64-encoded data with MIME type. Supports png, jpg, gif, webp, svg. Max 10MB.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Image file path relative to working directory' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_video',
      description: 'Read a local video file and attach it for VL model analysis. Supports mp4, mov, m4v, webm, mkv. Max 50MB.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Video file path relative to working directory' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'spawn_process',
      description: 'Start a long-running background process (e.g., dev server, watcher). Returns a process ID for checking output later. Auto-kills after 5 minutes.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_process_output',
      description: 'Read stdout/stderr from a previously spawned background process. Returns latest output and whether the process is still running.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'string', description: 'Process ID returned by spawn_process' }
        },
        required: ['pid']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the user a question and wait for their response. Use when you need clarification, confirmation, or user input to proceed with a task.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user' }
        },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'diff_files',
      description: 'Show a unified diff between two files, or between a file and its git HEAD version (if path_b is omitted).',
      parameters: {
        type: 'object',
        properties: {
          path_a: { type: 'string', description: 'First file path (or the only path when comparing against git HEAD)' },
          path_b: { type: 'string', description: 'Second file path. Omit to diff against git HEAD.' }
        },
        required: ['path_a']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'count_tokens',
      description: 'Estimate the token count of a text string using character and word heuristics.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to estimate token count for' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clipboard_read',
      description: 'Read the current contents of the system clipboard.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clipboard_write',
      description: 'Write text to the system clipboard.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to write to the clipboard' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git',
      description: 'Run git commands in the working directory. Supports status, diff, log, blame, add, commit, branch, checkout, stash, show, and more. The words go to git as given, without a shell: quote a whole word that has spaces ("like this"). Blocks destructive operations (push --force, reset --hard).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Git subcommand and arguments (e.g., "status", "diff src/", "log --oneline -10", "commit -m \\"fix: typo\\"", "blame file.ts")' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_datetime',
      description: 'Get the current date, time, and timezone. Use this when you need to know the current date or time.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  // Appended last on purpose: the catalog order is part of the cached prompt
  // prefix, so new tools go at the end (see agent/toolPresets.ts).
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: TODO_WRITE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The COMPLETE task list, replacing any previous list.',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'What the task is: a short imperative line.' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'pending (not started) | in_progress (now) | completed (done).'
                }
              },
              required: ['content', 'status']
            }
          }
        },
        required: ['todos']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description: 'Load a skill (instructions for a kind of work) by its name from the Skills list in the system prompt, then follow it. Only offered when skills exist.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The skill name, exactly as listed' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Save one short, lasting fact or preference about the user or their work for future chats (shown to the user; they can remove it). Never passwords, keys, card numbers or health details.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The fact, as one short sentence' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Search saved memories from earlier chats.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to look for' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forget',
      description: 'Remove a saved memory by its id (e.g. m1a2b3c4d), when it is wrong or the user asks.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The memory id' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description: 'Schedule a prompt to run later or repeatedly in its own chat, with this chat\'s model and settings (the user approves it). Runs unattended: anything needing approval is refused. Times are the Mac\'s local time.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name, e.g. "Morning news brief"' },
          prompt: { type: 'string', description: 'The complete instruction to run each time (it starts with no memory of this chat)' },
          schedule: {
            type: 'object',
            description: 'One of: {"kind":"once","at":"2026-10-24T09:00"} · {"kind":"daily","time":"08:00"} · {"kind":"weekly","days":[1,3,5],"time":"18:30"} (0 = Sunday) · {"kind":"interval","minutes":60} (at least 15)',
            properties: {
              kind: { type: 'string', enum: ['once', 'daily', 'weekly', 'interval'] },
              at: { type: 'string' },
              time: { type: 'string' },
              days: { type: 'array', items: { type: 'integer' } },
              minutes: { type: 'integer' }
            },
            required: ['kind']
          }
        },
        required: ['title', 'prompt', 'schedule']
      }
    }
  },
  BROWSER_TOOL
]

const BUILTIN_TOOL_NAMES = new Set(BUILTIN_TOOLS.map(t => t.function.name))

/** Check if a tool name is a built-in tool */
export function isBuiltinTool(toolName: string): boolean {
  return BUILTIN_TOOL_NAMES.has(toolName)
}

/** Agentic system prompt injected when built-in tools are enabled and no custom system prompt is set.
 *
 * IMPORTANT: Do NOT describe tool call syntax (e.g. func(arg)) here.
 * The model's chat template already teaches the correct format via the
 * tools array (e.g. Qwen uses <tool_call>JSON</tool_call>, Llama uses
 * <|python_tag|>, Mistral uses [TOOL_CALLS]). Adding a second format
 * here causes the model to follow the WRONG one, breaking server-side
 * tool call parsing.
 */
export const AGENTIC_SYSTEM_PROMPT = `You are an expert software engineer with direct access to the project's file system, terminal, and the web.

You have tools available for file I/O (read, write, edit, patch, copy, move, delete to the Trash, restore an earlier version, create directories, read images), search and navigation (list directories, project tree, search file contents, find files by name, diff files, diagnostics), terminal commands (run commands, spawn background processes), git operations, web search, and utility functions (token counting, clipboard, asking the user questions), and a todo list for planning.

Use the provided tools to complete tasks. Chain multiple tool calls as needed — don't stop after a single tool call if more work is required.

CRITICAL RULES:
- After using tools, provide a final response. If the user explicitly requested exact final wording or a strict output format, follow that format exactly; otherwise provide a substantive response explaining what you found or did. NEVER stop after just executing tools.
- Don't narrate actions before doing them. Just make the tool call.
- Between consecutive tool calls, minimize text. Make the next tool call directly.
- ALWAYS read a file before editing it — edits require exact text match.
- For large files (>2000 lines), use offset/limit to read in chunks.
- Prefer batch edits for multiple changes to the same file.
- Use search tools to find code patterns instead of reading entire files.
- Use diagnostics after making code changes to catch errors early.
- Ask the user when you need clarification — don't guess.
- For multi-step tasks, plan with todo_write and keep it up to date.`
