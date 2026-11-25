import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, LoaderCircle, X } from "lucide-react";
import type { Service, ServicePatch } from "../shared/types.js";
import { api, errorMessage } from "./api.js";

export function FeatureError({ error }: { error: unknown }) {
  return error ? (
    <div className="error-notice" role="alert">
      <CircleAlert size={17} />
      <span>{errorMessage(error)}</span>
    </div>
  ) : null;
}

export function FeatureLoading({ label }: { label: string }) {
  return (
    <span className="loading-inline" role="status">
      <LoaderCircle size={16} className="spin" />
      {label}
    </span>
  );
}

export function FeatureModal({
  title,
  description,
  children,
  onClose,
  dismissible = true,
  initialFocus,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
  dismissible?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    initialFocus?.current?.focus();
    return () => dialog?.close();
  }, [initialFocus]);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        if (!dismissible) event.preventDefault();
      }}
      onClose={(event) => { if (!event.currentTarget.open) onClose(); }}
      onClick={(event) => {
        if (dismissible && event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <div className="modal-heading">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          <p id={`${id}-description`}>{description}</p>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => ref.current?.close()}
          disabled={!dismissible}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function useServiceSave(service: Service, expectedRevision?: number) {
  const client = useQueryClient();
  const [baseRevision, setBaseRevision] = useState(service.revision);
  return useMutation({
    mutationFn: (patch: Omit<ServicePatch, "expectedRevision">) =>
      api<Service>(`/services/${service.id}`, {
        method: "PATCH",
        body: { ...patch, expectedRevision: expectedRevision ?? baseRevision },
      }),
    onSuccess: (value) => {
      setBaseRevision(value.revision);
      client.setQueryData(["service", service.id], value);
      void client.invalidateQueries({
        queryKey: ["services", service.projectId],
      });
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function SaveFooter({
  pending,
  saved,
  disabled = false,
}: {
  pending: boolean;
  saved: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="configuration-footer">
      <span role="status">
        {saved
          ? "Configuration saved. Deploy to apply this revision."
          : "Saving does not change the running deployment."}
      </span>
      <button
        className="button button-primary"
        type="submit"
        disabled={pending || disabled}
      >
        {pending ? (
          <FeatureLoading label="Saving" />
        ) : (
          <>
            <Check size={16} />
            Save configuration
          </>
        )}
      </button>
    </div>
  );
}
