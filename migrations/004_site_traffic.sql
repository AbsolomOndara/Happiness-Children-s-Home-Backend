CREATE TABLE IF NOT EXISTS site_analytics_meta (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  tracking_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO site_analytics_meta (id)
VALUES (TRUE)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS site_page_views (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path VARCHAR(200) NOT NULL,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS site_page_views_time_idx ON site_page_views(viewed_at DESC);
CREATE INDEX IF NOT EXISTS site_page_views_path_time_idx ON site_page_views(path, viewed_at DESC);
