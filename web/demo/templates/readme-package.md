# @harbor/PKGNAME

Part of **harbor**, the code behind the tidewater gauges, charts and site.

```sh
bun add @harbor/PKGNAME
```

## Use

```ts
import { levelAt } from "@harbor/tides";

const now = levelAt(readings, Date.now());
```

## Develop

| Command       | What it does                 |
| ------------- | ---------------------------- |
| `bun test`    | runs the tests in `test/`    |
| `bun run check` | type checks the package    |

See the [docs](../../docs/getting-started/01-setup.md) for how the packages fit together.
