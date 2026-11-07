import { Chat } from "@/components/chat/chat";
import { requireSession } from "@/lib/auth/dal";
import { chatChoices } from "@/lib/chat/catalogue";
import { toDisplayName } from "@/lib/chat/greeting";

const Home = async () => {
  const session = await requireSession();

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {/* The model list is resolved here, per page, from the same catalogue the
          route validates against; the client only draws it. The greeting is
          resolved in the browser, from the user's own clock — see
          `lib/chat/greeting.ts`. */}
      <Chat
        choices={chatChoices()}
        firstName={toDisplayName(session.user.name)}
      />
    </main>
  );
};

export default Home;
