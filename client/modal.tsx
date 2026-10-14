import {
  Modal as HostModal,
  type ModalComponent,
  type ModalContentProps,
  type ModalProps,
} from "@getpaseo/plugin/client/react-native";
import { useShortcutBlock } from "./shortcuts";

/** Host Modal that suspends board shortcuts while open; the host keeps Esc and focus. */
function TrackedModal(props: ModalProps) {
  useShortcutBlock(props.open);
  return <HostModal {...props} />;
}
TrackedModal.Content = (props: ModalContentProps) => <HostModal.Content {...props} />;
export const Modal: ModalComponent = TrackedModal;
