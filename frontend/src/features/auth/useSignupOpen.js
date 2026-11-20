import { useEffect, useState } from "react";
import { signupStatusRequest } from "./api";

/**
 * null while asking the server, then true or false. The server refuses sign-up on its own when it is closed;
 * this only decides whether to offer it. If the question fails, `fallback` is used.
 */
export const useSignupOpen = (fallback) => {
  const [open, setOpen] = useState(null);
  useEffect(() => {
    let active = true;
    signupStatusRequest()
      .then((value) => active && setOpen(value))
      .catch(() => active && setOpen(fallback));
    return () => {
      active = false;
    };
  }, [fallback]);
  return open;
};
