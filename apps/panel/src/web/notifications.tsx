import { Toaster, toast } from "@yusufceng1z/ding-react";

toast.configure({ sound: true });

export function PanelNotifications() {
  return <Toaster position="bottom-right" theme="system" />;
}

export function notifyProjectCreated() {
  toast.success("Project created.");
}

export function notifyServiceQueued() {
  toast.success("Service created. Deployment queued.");
}
