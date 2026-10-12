import { useQuery } from "@tanstack/react-query";
import { api, APIError, type ServerConfig } from "@/api";
import { queryKeys } from "@/lib/queryKeys";

export function useMe() {
  const q = useQuery({ queryKey: queryKeys.me(), queryFn: api.me, retry: false });
  const unauth = q.error instanceof APIError && q.error.status === 401;
  return { ...q, unauth };
}

export function useCapability(name: keyof NonNullable<ServerConfig["capabilities"]>) {
  const config = useQuery({ queryKey: queryKeys.config(), queryFn: api.getConfig });
  return config.isSuccess && config.data.capabilities?.[name] !== false;
}
