-- 0012_county_zips: how many homes each ZIP code has on a county's roll, counted
-- once per roll file, so a profile can be told when a ZIP code has no homes in
-- the chosen county (a P.O.-box ZIP, or one in another county).
CREATE TABLE county_zip_counts (
  county_code  text NOT NULL,
  zip          text NOT NULL CHECK (zip ~ '^\d{5}$'),
  homes        integer NOT NULL CHECK (homes >= 0),
  source_file  text NOT NULL,
  file_date    date NOT NULL,
  PRIMARY KEY (county_code, zip)
);
CREATE INDEX county_zip_counts_zip ON county_zip_counts (zip);
ALTER TABLE county_zip_counts ENABLE ROW LEVEL SECURITY;
