# PgBouncer

Added in Project 3 (fix 5), not before: first reproduce `too many clients already` with
10 API instances × pool of 20 against `max_connections = 100`, then put PgBouncer in
transaction mode between them and Postgres. Its config goes here.
