-- One row per stored file. A POD attempt that the browser gave up on (watchdog) can still land its
-- insert late; with this index the retry's insert and the late one cannot both create a POD row.
create unique index load_documents_storage_path_uq on public.load_documents (storage_path);
