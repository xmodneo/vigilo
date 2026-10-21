import realPostgres from 'postgres';

export default function postgres(...args) {
  const client = realPostgres(...args);
  const end = client.end.bind(client);
  client.end = async (...endArgs) => {
    process.stderr.write('fixture_retirement_client_close_attempted\n');
    try { return await end(...endArgs); }
    finally { process.stderr.write('fixture_retirement_client_closed\n'); }
  };
  return client;
}
