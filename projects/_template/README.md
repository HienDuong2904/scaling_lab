# Project __P__: __NAME__

**Trains section __P__ of the question bank:** <which questions>

## Target numbers (set before writing code)

- <requests per second, rows, file size, response time>

## Run it

```bash
make up p=__P__                 # shared lab + this project's services
make load p=__P__ t=<test>      # one script from load/
```

## Break tests

| Script | What it breaks | Partner knobs |
| --- | --- | --- |
| `load/01-<test>.js` | | |

## Tags

`p__P__-naive`, then one tag per fix (`p__P__-fix1-<what>`, ...). `git checkout <tag> && make load p=__P__ t=<test>` reproduces any row of RESULTS.md.
