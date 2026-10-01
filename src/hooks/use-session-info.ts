import { useQuery } from "@tanstack/react-query";
import { decodeJwt, getToken } from "@/lib/auth-store";
import { n3Call } from "@/lib/n3-client";
import { N3_SESSION_INFO_KEY } from "@/lib/n3-master-keys";
import { normalizeSessionInfo, type SessionInfo } from "@/lib/session-info";
import { useAuthToken } from "./use-auth";

/**
 * Correction H §5: read-only N3 identity (company, tenant, signed-in user)
 * fetched through the existing same-origin proxy. Cached like any other master
 * query and refreshed by "Re-sync N3 Data".
 */
export function useSessionInfo() {
  const token = useAuthToken();
  return useQuery<SessionInfo>({
    queryKey: N3_SESSION_INFO_KEY,
    enabled: !!token,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const [company, user] = await Promise.allSettled([
        n3Call<unknown>("api/CompanyProfile/BasicInfo", { signal }),
        n3Call<unknown>("api/Users/Current", { signal }),
      ]);
      const t = getToken();
      const claims = t ? decodeJwt(t) : null;
      const info = normalizeSessionInfo({
        company: company.status === "fulfilled" ? company.value : null,
        user: user.status === "fulfilled" ? user.value : null,
        claims,
      });
      if (!info.company && !info.tenantId && !info.loginUser) {
        throw new Error("N3 did not return session information.");
      }
      return info;
    },
  });
}