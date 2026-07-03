# Phalanx Games

Games built on top of [Phalanx Engine](https://github.com/phaeton-forge/phalanx-engine).

## Games

| Game | Description |
| ---- | ----------- |
| [`chapaev`](./chapaev) | Mobile-friendly Chapayev board game with online multiplayer |
| [`arena-shooter`](./arena-shooter) | Top-down arena shooter prototype |
| [`direct-strike-babylon-example`](./direct-strike-babylon-example) | Babylon.js example/demo (deprecated) |

## Requirements

- Node.js `>= 24.0.0`
- pnpm `10.33.2`

## Quick Start

```bash
pnpm install
pnpm build
```

Run a specific game in dev mode:

```bash
pnpm dev:chapaev
# or
pnpm dev:arena-shooter
# or
pnpm dev:direct-strike
```

## Dependencies

All games depend on published `@phalanx-engine/*` packages from npm rather than local workspace links. If you need to develop against a local copy of Phalanx Engine, see the engine repository and use pnpm overrides or `pnpm link`.

## License

MIT
