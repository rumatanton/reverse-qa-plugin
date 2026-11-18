# reverse-qa (the plugin folder)

A Claude Code plugin that reverse-engineers an application with no documentation: architecture, security, roles and
workflows, requirements, user stories, test cases and a Playwright automation framework that it runs. Every claim it
writes cites a file and line in the app's source, and the source is never edited.

Install it from the marketplace in this repository (in Claude Code):

    /plugin marketplace add rumatanton/reverse-qa-plugin
    /plugin install reverse-qa@reverse-qa

or load this folder directly from a clone:

    claude --plugin-dir ./plugin

Then `/reverse-qa:init-target` puts your app under the tool and `/reverse-qa:recon <app>` runs the recipe.

How to use it, what works for which kind of app, the safety rules and the privacy note are in the
[README at the repository root](../README.md). The settings of a target are in
[docs/target-reference.md](../docs/target-reference.md).

- `agents/`: the four subagents. `skills/`: one job each, a script plus a SKILL.md. `hooks/`: the three hooks.
- `rules/`: the source readers (generic, php). `templates/`: the test framework, the drivers, a runtime, the k6 script.
- `mcp/`: the Xray MCP server. `lib/`: shared code. `tests/`: the plugin's own tests and fixture apps.

License: MIT (see `../LICENSE`).
