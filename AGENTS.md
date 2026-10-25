# Working on PocketRecall

Read [docs/CODEX_HANDOFF.md](docs/CODEX_HANDOFF.md) before changing this project. It contains the product brief, implementation map, verification status, GitHub synchronization blocker, and next tasks.

- Continue the existing implementation. The priority is durable 3D object memory and a convincing voice/audio/haptic demonstration in `/run`.
- Keep the product interface and spoken replies in English. Keep `README.md` a short English quickstart; put engineering details in `docs/`.
- Preserve the current visual direction: warm paper, charcoal media surfaces, restrained orange accents, prominent footage and spatial memory. Avoid a generic dashboard redesign.
- Distinguish synthetic input, dataset annotations, model output, and simulated wearer movement. A remembered position is not proof an object is still there or being carried.
- Preserve capture-time evidence, map identity, coordinate units, history, and atomic memory publication. Do not invent 3D coordinates from a language model or combine unaligned maps.
- Keep credentials in ignored local configuration. Never copy secrets into documentation, frontend code, generated previews, commits, or logs.
- After changing the Run frontend or shared preview dependencies, rebuild with `npm run preview:build`. Run checks appropriate to the change; provider mocks do not verify live APIs or browser behavior.
- Inspect the current local and remote Git state before synchronizing. The handoff records a remote branch with a different history and missing local work. Preserve both histories; do not force-push or discard local work.
- Continue authorized work without repeatedly asking for confirmation. If a real permission or environment boundary blocks progress, report the exact failed operation and distinguish it from a code failure.
