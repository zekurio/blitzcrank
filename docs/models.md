# Models and sign-in

The host needs three chat models and has no default for any of them. If a
model is unknown or its provider has no credentials, the host refuses to
start. Write each one as `provider/model[:thinking]`. Thinking defaults to
medium.

| Variable                  | NixOS option  | Example                           | Job                                           |
| ------------------------- | ------------- | --------------------------------- | --------------------------------------------- |
| `BLITZCRANK_MODEL`        | `model`       | `openai/gpt-6-astra:medium`       | Runs the agent                                |
| `BLITZCRANK_HELPER_MODEL` | `helperModel` | `openai/gpt-5.4-mini:off`         | Names Fluxer threads and other side jobs      |
| `BLITZCRANK_GATE_MODEL`   | `gateModel`   | `anthropic/claude-haiku-5-5:high` | Reviews [destructive writes](write-review.md) |

The helper model gets one instruction and one input per job, with no tools.
Pick something small and fast, and add `:off`, since the medium thinking
default is wasted on naming a thread.

The Fluxer gateway needs a fourth model, `FLUXER_TRIAGE_MODEL`, which is a
classifier rather than a chat model. [Connect Fluxer](fluxer.md#triage-model)
covers it.

## API keys

Providers with API keys read them from their usual environment variables,
such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Put them in the host's
environment file. No sign-in step is needed.

## OAuth

OAuth providers sign in through the host command:

```sh
blitzcrank auth login openai
blitzcrank auth status
blitzcrank auth logout openai
```

`openai` supports Sign in with ChatGPT. Open the URL the command prints,
then either let the callback finish or paste the final redirect URL back into
the terminal. Other OAuth providers use the same `auth login <provider>`.
Auth commands need no service credentials and no model settings.

On NixOS, run these with `sudo`. [Deploy](deploy.md#sign-in-on-the-server)
explains what that does to the service.

## Where credentials live

Credentials go to `<BLITZCRANK_DATA_DIR>/auth.json`, or `data/auth.json` when
running locally. `BLITZCRANK_AUTH_PATH` overrides the path, and the NixOS
option is `services.blitzcrank.authFile`. The file must stay writable because
the SDK saves refreshed OAuth tokens back to it. Next to it, `.device-id`
holds a stable installation UUID used at login.

blitzcrank ignores any Pi auth or model config already on the machine. To use
a custom provider, point `BLITZCRANK_MODELS_PATH` at a models file.
