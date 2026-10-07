# eval-kit-swe-pro

`eval-kit-swe-pro` is the standalone repository for the SWE-bench Pro
evaluation behavior provided by the CodeHelix `swe-pro-kit` plugin. The plugin
ID and evaluation implementation are intentionally retained so results and
existing installation contracts stay comparable with CodeHelix.

## Advisor-free by default

The supported baseline does **not** require Lingxi Advisor, Task Pattern
Advisor, or any other knowledge plugin. These settings run independently:

- `single-decoder`
- `three-decoder`
- `three-decoder-serial`
- `three-decoder-icode-workflow`
- `sub-agent`
- `sub-agent-serial`
- `legacy-workflow`

The existing `taskpattern-evaluation` setting is retained for behavioral
parity with `swe-pro-kit`, but it is explicit and optional. It now binds the
installed `LingxiAdvisor` profile and its `lingxi.advisor.search` /
`lingxi.advisor.apply` tools. It is not loaded by the default installation or
any baseline setting, and it is not required for the standalone baseline path.

Lingxi Advisor is maintained separately at
[spine-se-lab/Lingxi-advisor](https://github.com/spine-se-lab/Lingxi-advisor).
This repository owns evaluation runners, settings, result collection, and
benchmark documentation; Lingxi Advisor does not copy that implementation.

## Requirements

- Node.js 18 or later
- Git
- iCode/Chrys 0.28.0
- an existing Python 3.14+ environment with Harbor 0.7.0

Harbor 0.7.0 is preserved from the validated `swe-pro-kit` behavior, including
its Docker `network_mode: none` evaluation isolation. The installer validates
the external environment and does not create or remove it implicitly.

## Install

```sh
git clone https://github.com/spine-se-lab/eval-kit-swe-pro.git
cd eval-kit-swe-pro
npm install
npx . install --agent icode \
  --target /absolute/path/to/chrys \
  --config-root /absolute/path/to/chrys-config
```

To use an existing Harbor environment, append:

```sh
--set python=/absolute/path/to/harbor-env/bin/python
```

The repository uses the same CodeHelix installation protocol as the source
plugin and can also be consumed by a compatible CodeHelix host as a
single-plugin repository.

## Run without an Advisor

Select a model profile through the startup environment and choose a baseline
setting explicitly:

```sh
export SWE_PRO_MODEL_PROFILE=my-evaluation-model
python3 /absolute/path/to/chrys-config/swe-pro-kit/run.py \
  --setting single-decoder \
  -d scale-ai/swe-bench-pro \
  -i '<task-name>' \
  -o /absolute/path/to/runs/baseline \
  --n-concurrent 1
```

Use `SWE_PRO_API_KEY` or `OPENAI_API_KEY` for the selected provider. Secrets
are read from the launch environment and are not written to model profiles.
The default run disables implicit user/project Skills and hooks so an Advisor
cannot be included accidentally.

Each trial retains the original Harbor result, stage traces,
`baseline-run.json`, `solution.patch`, model/profile metadata, and token usage.
Compare runs only when task set, model, setting, profiles, bindings, and budget
are held constant.

## Development

```sh
npm run build
npm run validate
python -m pytest -q tests
```

The generated delivery is derived from `plugins/swe-pro-kit/source`; do not
edit `plugins/swe-pro-kit/delivery` directly. Detailed setting, installation,
and runtime behavior remains documented in
[the plugin README](plugins/swe-pro-kit/README.md).

## License

MIT License. See [LICENSE](LICENSE).
