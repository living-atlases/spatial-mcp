// POC CI for spatial-mcp on jenkins.gbif.es.
// Runs the unit tests, then the integration tests against the LA demo stack (spatial.l-a.site) that the
// la-docker-compose-tests job deploys. It never deploys or cleans anything itself, and it waits while
// la-docker-compose-tests is running (that job wipes /data and redeploys the stack).
// Admin credentials are read from the lademo inventory on the agent, like la-docker-compose-tests' E2E
// stage does, and are never echoed.
pipeline {
    agent any
    tools { nodejs 'node-22' }
    options {
        disableConcurrentBuilds()
        timestamps()
        timeout(time: 240, unit: 'MINUTES')
    }
    triggers { cron('H 5 * * *') }
    environment {
        // params.* exist on the first build too; as env vars only once the job knows its parameters.
        SPATIAL_TEST_URL = "${params.SPATIAL_TEST_URL ?: 'https://spatial.l-a.site/ws'}"
        OIDC_ISSUER = "${params.OIDC_ISSUER ?: 'https://auth.l-a.site/cas/oidc'}"
        INVENTORY_DIR = "${params.INVENTORY_DIR ?: '${HOME}/ala-install-docker-tests/lademo/lademo-inventories'}"
        RUN_WRITE_TESTS = "${params.RUN_WRITE_TESTS == null ? true : params.RUN_WRITE_TESTS}"
    }
    parameters {
        string(name: 'SPATIAL_TEST_URL', defaultValue: 'https://spatial.l-a.site/ws', description: 'spatial-service under test (base URL including /ws)')
        string(name: 'OIDC_ISSUER', defaultValue: 'https://auth.l-a.site/cas/oidc', description: 'OIDC issuer of that stack')
        string(name: 'INVENTORY_DIR', defaultValue: '${HOME}/ala-install-docker-tests/lademo/lademo-inventories', description: 'lademo inventory with lademo-local-passwords.ini')
        booleanParam(name: 'RUN_WRITE_TESTS', defaultValue: true, description: 'Create and delete an mcp_poc_* layer on the stack (needs the admin credentials of the inventory)')
    }
    stages {
        stage('Unit tests') {
            steps {
                sh 'npm ci'
                sh 'npm run typecheck'
                sh 'mkdir -p test-results'
                sh 'node --import tsx --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=test-results/unit.xml test/*.test.ts'
            }
        }
        stage('Wait for lademo') {
            steps {
                script {
                    // Do not run while the stack is being wiped/redeployed.
                    // Read its state from JENKINS_HOME (this runs on the controller): the public API sits behind
                    // an anti-bot page. A pipeline run's build.xml says <completed>true</completed> once it ends.
                    // Fail closed: if the state cannot be read, do not test a stack that may be half deployed.
                    timeout(time: 150, unit: 'MINUTES') {
                        waitUntil(initialRecurrencePeriod: 60000) {
                            def state = sh(returnStdout: true, script: '''
                                d="${JENKINS_HOME}/jobs/la-docker-compose-tests/builds"
                                n=$(ls "$d" 2>/dev/null | grep -E '^[0-9]+$' | sort -n | tail -1)
                                if [ -z "$n" ]; then echo unknown
                                elif grep -q '<completed>true</completed>' "$d/$n/build.xml" 2>/dev/null; then echo "idle #$n"
                                else echo "running #$n"; fi
                            ''').trim()
                            if (state == 'unknown') { error "Cannot read la-docker-compose-tests builds under ${env.JENKINS_HOME}" }
                            echo "la-docker-compose-tests: ${state}"
                            return state.startsWith('idle')
                        }
                    }
                    sh 'curl -fsS -o /dev/null -w "spatial-service: %{http_code}\\n" "${SPATIAL_TEST_URL}/fields"'
                }
            }
        }
        stage('Integration tests') {
            steps {
                sh '''
                    set -eu
                    set +x
                    export SPATIAL_TEST_URL="${SPATIAL_TEST_URL}"
                    INV=$(eval echo "${INVENTORY_DIR}")
                    PW="$INV/lademo-local-passwords.ini"
                    if [ "${RUN_WRITE_TESTS}" = "true" ] && [ -f "$PW" ]; then
                        val() { sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*([^[:space:]]+).*/\\1/p" "$PW" | head -1; }
                        export SPATIAL_OIDC_ISSUER="${OIDC_ISSUER}"
                        export SPATIAL_OIDC_CLIENT_ID="$(val spatial_client_id)"
                        export SPATIAL_OIDC_CLIENT_SECRET="$(val spatial_client_secret)"
                        export SPATIAL_USERNAME="$(val cas_first_admin_email)"
                        export SPATIAL_PASSWORD="$(sed -nE 's/.*random password:[[:space:]]*([^[:space:]]+).*/\\1/p' "$PW" | head -1)"
                        export SPATIAL_OIDC_USERNAME="$SPATIAL_USERNAME" SPATIAL_OIDC_PASSWORD="$SPATIAL_PASSWORD"
                        export SPATIAL_API_KEY="$(val spatial_service_service_key)"
                        echo "admin credentials: from $PW (user $SPATIAL_USERNAME)"
                    else
                        echo "no admin credentials: only public/anonymous integration tests run"
                    fi
                    mkdir -p test-results
                    node --import tsx --test --test-concurrency=1 --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=test-results/integration.xml test/integration/*.test.ts
                '''
            }
        }
    }
    post {
        always {
            junit allowEmptyResults: true, testResults: 'test-results/*.xml'
        }
    }
}
