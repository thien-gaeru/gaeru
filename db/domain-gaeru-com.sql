DO $$
DECLARE
  pat text := '\m(https?://)?(www\.)?gaeru\.o' || 'rg\M';
BEGIN
  UPDATE news_posts
  SET title = regexp_replace(title, pat, '\1gaeru.com', 'gi'),
      excerpt = regexp_replace(excerpt, pat, '\1gaeru.com', 'gi'),
      body = regexp_replace(body, pat, '\1gaeru.com', 'gi'),
      image_alt = regexp_replace(image_alt, pat, '\1gaeru.com', 'gi')
  WHERE title ~* pat OR excerpt ~* pat OR body ~* pat OR image_alt ~* pat;

  UPDATE site_pages
  SET title = regexp_replace(title, pat, '\1gaeru.com', 'gi'),
      description = regexp_replace(description, pat, '\1gaeru.com', 'gi'),
      body = regexp_replace(body, pat, '\1gaeru.com', 'gi')
  WHERE title ~* pat OR description ~* pat OR body ~* pat;

  UPDATE products
  SET name = regexp_replace(name, pat, '\1gaeru.com', 'gi'),
      descriptor = regexp_replace(descriptor, pat, '\1gaeru.com', 'gi'),
      description = regexp_replace(description, pat, '\1gaeru.com', 'gi'),
      card_title = regexp_replace(card_title, pat, '\1gaeru.com', 'gi'),
      card_summary = regexp_replace(card_summary, pat, '\1gaeru.com', 'gi'),
      image_alt = regexp_replace(image_alt, pat, '\1gaeru.com', 'gi')
  WHERE name ~* pat OR descriptor ~* pat OR description ~* pat OR card_title ~* pat OR card_summary ~* pat OR image_alt ~* pat;

  UPDATE marketing_campaigns
  SET title = regexp_replace(title, pat, '\1gaeru.com', 'gi'),
      body = regexp_replace(body, pat, '\1gaeru.com', 'gi')
  WHERE title ~* pat OR body ~* pat;

  UPDATE marketing_email_campaigns
  SET title = regexp_replace(title, pat, '\1gaeru.com', 'gi'),
      subject = regexp_replace(subject, pat, '\1gaeru.com', 'gi'),
      body = regexp_replace(body, pat, '\1gaeru.com', 'gi')
  WHERE title ~* pat OR subject ~* pat OR body ~* pat;

  UPDATE shopping_chat_messages
  SET body = regexp_replace(body, pat, '\1gaeru.com', 'gi')
  WHERE body ~* pat;

  UPDATE care_messages
  SET body = regexp_replace(body, pat, '\1gaeru.com', 'gi')
  WHERE body ~* pat;

  UPDATE care_requests
  SET response = regexp_replace(response, pat, '\1gaeru.com', 'gi')
  WHERE response ~* pat;

  UPDATE store_settings
  SET setting_value = regexp_replace(setting_value::text, pat, '\1gaeru.com', 'gi')::jsonb
  WHERE setting_key NOT LIKE 'private_admin:%' AND setting_value::text ~* pat;
END $$;
