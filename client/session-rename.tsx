import { useState } from "react";
import { View } from "react-native";
import { Modal } from "./modal";
import { Actions, Button, Field, Theme, useTheme } from "./ui";
import { t } from "../shared/i18n";

/** Renames a session (its Paseo display name). Mount it while open: the field is seeded once. */
export function RenameSession({
  title,
  onSave,
  onClose,
}: {
  title: string;
  /** Resolves true when the new title was saved; the dialog then closes. */
  onSave(title: string): Promise<boolean>;
  onClose(): void;
}) {
  const theme = useTheme();
  const [value, setValue] = useState(title);
  const [pending, setPending] = useState(false);
  const next = value.trim();
  const canSave = !pending && !!next && next !== title.trim();
  async function save() {
    setPending(true);
    const saved = await onSave(next);
    setPending(false);
    if (saved) onClose();
  }
  return (
    <Modal
      open
      title={t("Rename session")}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: 16 }}>
          <Field
            title={t("Session title")}
            value={value}
            onChange={setValue}
            editable={!pending}
            autoFocus
            onSubmit={canSave ? () => void save() : undefined}
          />
          <Actions>
            <Button quiet disabled={pending} onPress={onClose}>
              {t("Cancel")}
            </Button>
            <Button primary disabled={!canSave} onPress={() => void save()}>
              {pending ? t("Saving…") : t("Save")}
            </Button>
          </Actions>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}
