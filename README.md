# smjsonparser

Imports the JSON case batches written by
[smapiexporter](https://github.com/TitanXV4000/smapiexporter) into the Mongo `cases`
collection used by qmon and wallboard. It replaces smreportparser, which read the CSV
report downloads.

- Batches are read one at a time, oldest first, including any left from before startup.
- A batch file is deleted only after its cases were written to Mongo; if the write fails
  the file stays and is read again when the parser restarts.
- Cases are updated with `$set`, so a field a batch doesn't carry (Description comes only
  for changed cases) keeps its stored value.
- Status, priority, case type, creation source and phase are stored as the labels OTSM
  shows, with the internal value in `<field>Id`. Names are stored as "First Last".
- If no batch arrives for 10 minutes it sends an email alert and exits.

## Settings (environment)

| Variable | Default |
|---|---|
| `MONGO_URI` | `mongodb://localhost:27017/...` |
| `MONGO_DB` | `smwb` |
| `DOWNLOAD_PATH` | `/smexports-api` |
| `EMAIL_FROM`, `EMAIL_FROM_PASS`, `EMAIL_TO` | alert email (Gmail) |
| `LOG_LEVEL`, `SERVICE_NAME`, `TIMEZONE`, `NODE_ENV` | logging |

## Run

```
docker build -t tsanford/smjsonparser .
docker run -d --name smjsonparser --restart unless-stopped -e TZ=America/Denver \
  --add-host host.docker.internal:host-gateway -v smapidata:/smexports-api \
  --env-file smjsonparser.env tsanford/smjsonparser
```
