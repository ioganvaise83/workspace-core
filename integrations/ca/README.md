# Custom CA placeholder

`empty-ca.pem` is intentionally empty and intentionally committed.

`compose.yaml` needs a `secrets` source that exists on every checkout, even for
users who have no corporate TLS inspection. Compose hands that path to BuildKit
and the build fails if the file is absent, so a placeholder is the only way to
keep the feature optional without asking the user to edit `compose.yaml`.

The Dockerfile and the Gmail entrypoint both test the file with `-s`, which is
false for a zero-byte file. An empty placeholder therefore means "no custom CA"
and the containers use their normal trust store.

Do not put a real certificate here. Point `CUSTOM_CA_PATH` in `.env` at the PEM
on the host instead; that path is mounted read-only and never enters Git.

If you delete this file, `docker compose build` stops working until you restore
it or set `CUSTOM_CA_PATH` to an existing certificate.
