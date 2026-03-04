export interface AccountQuota {
  rate_limit?: {
    used_percent?: number | null;
    limit_reached?: boolean;
    reset_at?: number | null;
    limit_window_seconds?: number | null;
  };
}

export interface Account {
  id: string;
  email: string;
  status: string;
  planType?: string;
  usage?: {
    request_count?: number;
    input_tokens?: number;
    output_tokens?: number;
    window_request_count?: number;
    window_input_tokens?: number;
    window_output_tokens?: number;
  };
  quota?: AccountQuota;
}
