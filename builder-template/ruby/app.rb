# Serves the UI from public/ and runs Agent Hub workflows for it; the tokens in jr-workflows.json never reach the browser.
require 'json'
require 'net/http'
require 'sinatra/base'

class App < Sinatra::Base
  set :public_folder, File.join(__dir__, 'public')
  set :host_authorization, { permitted_hosts: [] }

  helpers do
    def workflow_config
      JSON.parse(File.read(File.join(__dir__, 'jr-workflows.json')))
    rescue StandardError
      { 'workflows' => {} }
    end
  end

  get '/' do
    send_file File.join(settings.public_folder, 'index.html')
  end

  post '/api/workflows/:key' do
    content_type :json
    cfg = workflow_config
    flow = (cfg['workflows'] || {})[params[:key]]
    unless flow
      $stdout.puts "[workflow] #{params[:key]}: unknown workflow (check jr-workflows.json)"
      halt 404, { status: 'failed', error: 'Unknown workflow' }.to_json
    end
    started = Time.now
    input = JSON.parse(request.body.read) rescue {}
    uri = URI("#{cfg['base']}/hooks/workflows/#{flow['id']}/run")
    begin
      res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https', read_timeout: 180) do |http|
        req = Net::HTTP::Post.new(uri, 'Content-Type' => 'application/json', 'Authorization' => "Bearer #{flow['token']}")
        req.body = { input: input }.to_json
        http.request(req)
      end
    rescue StandardError => e
      $stdout.puts "[workflow] #{params[:key]}: could not reach #{cfg['base']} (#{e.message})"
      halt 502, { status: 'failed', error: "Could not reach Jr Architect at #{cfg['base']}" }.to_json
    end
    run = JSON.parse(res.body) rescue {}
    $stdout.puts "[workflow] #{params[:key]} -> #{run['status'] || res.code} in #{((Time.now - started) * 1000).round}ms#{run['error'] ? ": #{run['error']}" : ''}"
    status(res.code.to_i < 300 ? 200 : res.code.to_i)
    { status: run['status'] || 'failed', output: run['output'], error: run['error'] }.to_json
  end
end
