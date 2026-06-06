"use client";
import {
  useMutation,
  useQueryClient,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { useOrgSlug, orgQueryKey } from "./keys";
import { notifyError } from "@/lib/errors/notify";

/**
 * Like useMutation, but automatically invalidates any provided org-scoped
 * subkeys on success. Pass the same `parts` you'd give useOrgQueryKey.
 *
 *   useOrgMutation({
 *     mutationFn: (theme: Theme) => jsonFetch("/api/v1/orgs/.../theme", { method: "PATCH", body: JSON.stringify(theme) }),
 *     invalidate: [["themes"], ["preferences"]],
 *   })
 */
export function useOrgMutation<
  TData,
  TError,
  TVariables,
  TOnMutateResult = unknown,
>(
  options: UseMutationOptions<TData, TError, TVariables, TOnMutateResult> & {
    invalidate?: unknown[][];
  },
) {
  const orgSlug = useOrgSlug();
  const qc = useQueryClient();
  const { invalidate, onSuccess, onError, ...rest } = options;

  return useMutation<TData, TError, TVariables, TOnMutateResult>({
    ...rest,
    // Default: surface failures as an error toast. A caller that passes its own
    // onError (e.g. to show an inline message) opts out of the default toast.
    onError: onError ?? ((err) => notifyError(err)),
    onSuccess: async (data, vars, onMutateResult, ctx) => {
      if (invalidate) {
        await Promise.all(
          invalidate.map((parts) =>
            qc.invalidateQueries({
              queryKey: orgQueryKey(orgSlug, ...parts),
            }),
          ),
        );
      }
      if (onSuccess) await onSuccess(data, vars, onMutateResult, ctx);
    },
  });
}
