ALTER TABLE omnichannel_events ADD COLUMN IF NOT EXISTS event_id text;
CREATE UNIQUE INDEX IF NOT EXISTS omnichannel_events_channel_event_id_uq 
  ON omnichannel_events (channel, event_id) 
  WHERE event_id IS NOT NULL;
