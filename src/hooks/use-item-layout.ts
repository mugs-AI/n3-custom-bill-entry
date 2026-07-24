import { useEffect, useState } from "react";
import { LAYOUT_EVENT, loadLayout, type ItemLayout } from "@/lib/item-layout";
import { AUTH_EVENT } from "@/lib/auth-store";

/** Read the current item layout from localStorage (client-only). */
export function useItemLayout(): ItemLayout {
  const [layout, setLayout] = useState<ItemLayout>(() => loadLayout());
  useEffect(() => {
    setLayout(loadLayout());
    const onChange = () => setLayout(loadLayout());
    window.addEventListener(LAYOUT_EVENT, onChange);
    window.addEventListener(AUTH_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(LAYOUT_EVENT, onChange);
      window.removeEventListener(AUTH_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return layout;
}
