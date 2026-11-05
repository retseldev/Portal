import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js";

const isConfigured = SUPABASE_URL.startsWith("https://")
  && !SUPABASE_URL.includes("YOUR-PROJECT-REF")
  && SUPABASE_ANON_KEY.length > 20
  && !SUPABASE_ANON_KEY.includes("YOUR-SUPABASE");

export const supabase = isConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
