import { Chat } from "@/components/chat/chat";
import { requireSession } from "@/lib/auth/dal";
import { chatSelections } from "@/lib/chat/catalogue";
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
        firstName={toDisplayName(session.user.name)}
        selections={chatSelections()}
      />
    </main>
  );
};

export default Home;
