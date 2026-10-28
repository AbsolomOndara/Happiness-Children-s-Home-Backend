ALTER TABLE gallery_photos
  ADD COLUMN IF NOT EXISTS category VARCHAR(60) NOT NULL DEFAULT 'Everyday life';

CREATE INDEX IF NOT EXISTS gallery_category_idx ON gallery_photos(category, sort_order, created_at DESC);

CREATE TABLE IF NOT EXISTS contact_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(140) NOT NULL,
  email VARCHAR(254) NOT NULL,
  phone VARCHAR(32) NOT NULL DEFAULT '',
  subject VARCHAR(140) NOT NULL DEFAULT 'General enquiry',
  message TEXT NOT NULL,
  preferred_contact VARCHAR(20) NOT NULL DEFAULT 'email',
  status VARCHAR(20) NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS contact_inquiries_recent_idx ON contact_inquiries(status, created_at DESC);

CREATE TABLE IF NOT EXISTS donors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  phone VARCHAR(32) NOT NULL,
  country VARCHAR(100) NOT NULL,
  interests VARCHAR(80) NOT NULL DEFAULT 'General support',
  consent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS donors_recent_idx ON donors(created_at DESC);
CREATE INDEX IF NOT EXISTS donors_country_idx ON donors(country);

CREATE TABLE IF NOT EXISTS donor_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_id UUID NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('email','whatsapp')),
  message TEXT NOT NULL,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS donor_reminders_recent_idx ON donor_reminders(donor_id, prepared_at DESC);
