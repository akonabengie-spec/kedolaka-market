UPDATE freight_rates
   SET active = FALSE, updated_at = NOW()
 WHERE provider = 'PostPNG' AND active = TRUE;
