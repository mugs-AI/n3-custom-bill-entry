import { useEffect, useState } from "react";
import { getToken } from "@/lib/auth-store";

export function useAuthToken(): string | null {
  const [token, setTokenState] = useState<string | null>(null);
  useEffect(() => {
    setTokenState(getToken());
    const onChange = () => setTokenState(getToken());
    window.addEventListener("n3-auth-change", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("n3-auth-change", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return token;
}
