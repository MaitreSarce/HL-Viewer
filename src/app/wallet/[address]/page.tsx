import Home from "@/app/page";

type WalletPageProps = {
  params: Promise<{
    address: string;
  }>;
};

export default async function WalletPage({ params }: WalletPageProps) {
  const { address } = await params;
  return <Home initialAddress={decodeURIComponent(address)} />;
}
